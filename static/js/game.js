
"use strict";

const $ = (selector) => document.querySelector(selector);

const authScreen = $("#authScreen");
const gameScreen = $("#gameScreen");
const authForm = $("#authForm");
const authMessage = $("#authMessage");

let authMode = "login";
let socket = null;
let scene, camera, renderer, clock;
let rider, riderPivot, scooter;
let animationStarted = false;
let saveTimer = 0;
let networkTimer = 0;
let reconnectMessageTimer = 0;
let lastFrame = 0;

const keys = {
  gas: false,
  brake: false,
  left: false,
  right: false,
  wheelie: false
};

const physics = {
  x: 0,
  z: 0,
  heading: 0,
  speed: 0,
  wheelie: 0,
  wheelieVelocity: 0,
  lean: 0,
  steering: 0,
  grounded: true
};

let playerId = null;
let currentPlayer = null;
const remotePlayers = new Map();
const remoteTargets = new Map();

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;

function setAuthMode(mode) {
  authMode = mode;

  $("#loginTab").classList.toggle("selected", mode === "login");
  $("#registerTab").classList.toggle("selected", mode === "register");
  $("#submitAuth").textContent =
    mode === "login" ? "Anmelden" : "Account erstellen";
  $("#password").autocomplete =
    mode === "login" ? "current-password" : "new-password";
  authMessage.textContent = "";
}

$("#loginTab").addEventListener("click", () => setAuthMode("login"));
$("#registerTab").addEventListener("click", () => setAuthMode("register"));

async function api(path, data = {}) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Anfrage fehlgeschlagen.");
  }

  return result;
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const button = $("#submitAuth");
  button.disabled = true;
  authMessage.textContent = "Verbindung wird hergestellt …";

  try {
    const result = await api(
      authMode === "login" ? "/api/login" : "/api/register",
      {
        username: $("#username").value,
        password: $("#password").value
      }
    );

    showGame(result.player);
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// If a valid Flask session already exists, restore the account.
async function restoreSession() {
  try {
    const response = await fetch("/api/me", {
      credentials: "same-origin"
    });

    if (!response.ok) return;

    const result = await response.json();
    if (result.player) showGame(result.player);
  } catch (error) {
    console.warn("Session restore failed:", error);
  }
}

function showGame(player) {
  if (!player || animationStarted) return;

  currentPlayer = player;
  authScreen.hidden = true;
  gameScreen.hidden = false;

  $("#playerName").textContent = player.username || "Rider";
  $("#coins").textContent = "🪙 " + (player.coins ?? 0);
  $("#scooterName").textContent = player.equipped_scooter || "Starter";

  physics.x = Number(player.x) || 0;
  physics.z = Number(player.z) || 0;
  physics.heading = Number(player.rotation) || 0;

  startWorld();
  connectMultiplayer();
}

function connectMultiplayer() {
  if (socket) socket.disconnect();

  socket = io({
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    socket.emit("join_game");
    $("#gameMessage").textContent = "";
  });

  socket.on("welcome", (data) => {
    playerId = data.id;
    (data.players || []).forEach(updateRemotePlayer);
    updateOnlineCount();
  });

  socket.on("players_update", (players) => {
    players.forEach(updateRemotePlayer);

    const visibleIds = new Set(players.map((p) => p.id));

    for (const [id, mesh] of remotePlayers) {
      if (!visibleIds.has(id)) {
        scene.remove(mesh);
        remotePlayers.delete(id);
        remoteTargets.delete(id);
      }
    }

    updateOnlineCount();
  });

  socket.on("player_left", (data) => {
    removeRemote(data.id);
  });

  socket.on("auth_required", () => {
    $("#gameMessage").textContent = "Bitte melde dich erneut an.";
  });

  socket.on("disconnect", () => {
    $("#gameMessage").textContent = "Multiplayer-Verbindung unterbrochen …";
  });

  socket.on("connect_error", () => {
    $("#gameMessage").textContent = "Verbinde erneut mit dem Server …";
  });
}

function updateOnlineCount() {
  $("#onlineCount").textContent =
    `${remotePlayers.size + 1} Spieler online`;
}

function removeRemote(id) {
  const mesh = remotePlayers.get(id);
  if (mesh && scene) scene.remove(mesh);
  remotePlayers.delete(id);
  remoteTargets.delete(id);
  updateOnlineCount();
}

function updateRemotePlayer(player) {
  if (!scene || player.id === playerId) return;

  let mesh = remotePlayers.get(player.id);

  if (!mesh) {
    mesh = makeScooter(player.color || "#38c7ff");
    scene.add(mesh);
    remotePlayers.set(player.id, mesh);
  }

  remoteTargets.set(player.id, {
    x: Number(player.x) || 0,
    z: Number(player.z) || 0,
    rot: Number(player.rot) || 0,
    wheelie: clamp(Number(player.wheelie) || 0, 0, 0.75),
    speed: Number(player.speed) || 0
  });
}

function makeMaterial(color, roughness = 0.75, metalness = 0) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness
  });
}

function addBox(parent, material, x, y, z, sx, sy, sz) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(sx, sy, sz),
    material
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addCylinder(parent, material, x, y, z, radius, height, segments = 12) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, segments),
    material
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeScooter(color = "#ff8a24") {
  // The pivot rotates the front assembly upward during a wheelie.
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  const rubber = makeMaterial("#161b21", 0.95);
  const tireSide = makeMaterial("#343a42", 0.85);
  const metal = makeMaterial("#a9b6c2", 0.35, 0.65);
  const frame = makeMaterial(color, 0.4, 0.25);
  const dark = makeMaterial("#202934", 0.45, 0.3);
  const seat = makeMaterial("#171b22", 0.85);
  const light = new THREE.MeshStandardMaterial({
    color: "#fff4cb",
    emissive: "#ffd17c",
    emissiveIntensity: 1.5
  });

  function wheel(z) {
    const group = new THREE.Group();
    group.position.set(0, 0.34, z);
    chassis.add(group);

    const tire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.16, 24),
      rubber
    );
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    group.add(tire);

    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.205, 0.205, 0.17, 16),
      metal
    );
    rim.rotation.z = Math.PI / 2;
    group.add(rim);

    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.18, 12),
      tireSide
    );
    hub.rotation.z = Math.PI / 2;
    group.add(hub);

    for (let i = 0; i < 8; i++) {
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.025, 0.035),
        metal
      );
      spoke.rotation.x = i * Math.PI / 4;
      group.add(spoke);
    }

    return group;
  }

  const rearWheel = wheel(0.78);
  const frontAssembly = new THREE.Group();
  frontAssembly.position.set(0, 0.42, -0.72);
  chassis.add(frontAssembly);

  const frontWheel = new THREE.Group();
  frontWheel.position.set(0, -0.08, -0.12);
  frontAssembly.add(frontWheel);

  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.16, 24),
    rubber
  );
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  frontWheel.add(tire);

  const frontRim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.17, 16),
    metal
  );
  frontRim.rotation.z = Math.PI / 2;
  frontWheel.add(frontRim);

  addBox(chassis, frame, 0, 0.62, 0.02, 0.48, 0.16, 1.2);
  addBox(chassis, dark, 0, 0.72, 0.03, 0.37, 0.08, 0.83);

  const rearFender = addBox(chassis, frame, 0, 0.66, 0.91, 0.3, 0.1, 0.48);
  rearFender.rotation.x = -0.13;

  addBox(chassis, dark, 0, 1.04, 0.28, 0.31, 0.42, 0.48);

  // Front fork and steering column.
  const fork = addCylinder(
    frontAssembly, metal, 0, 0.22, 0.01, 0.055, 0.64, 10
  );
  fork.rotation.x = -0.13;

  const stem = addCylinder(
    chassis, frame, 0, 1.05, -0.52, 0.055, 0.9, 10
  );
  stem.rotation.x = -0.29;

  addBox(chassis, dark, 0, 1.48, -0.66, 0.78, 0.07, 0.1);

  // Headlight.
  const headlight = new THREE.Mesh(
    new THREE.SphereGeometry(0.105, 12, 10),
    light
  );
  headlight.position.set(0, 1.25, -0.67);
  chassis.add(headlight);

  const rider = new THREE.Group();
  chassis.add(rider);

  // Stylized rider silhouette; independent of the scooter body.
  const jacket = makeMaterial("#263d57", 0.82);
  const pants = makeMaterial("#252a32", 0.9);
  const skin = makeMaterial("#d8a77d", 0.85);
  const helmet = makeMaterial("#f2f3f5", 0.4);

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.19, 0.42, 4, 8), jacket
  );
  torso.position.set(0, 1.43, 0.12);
  torso.rotation.x = -0.22;
  torso.castShadow = true;
  rider.add(torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 16, 12), helmet
  );
  head.position.set(0, 1.84, -0.04);
  head.castShadow = true;
  rider.add(head);

  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.07, 0.06),
    makeMaterial("#1b2d3d", 0.2, 0.4)
  );
  visor.position.set(0, 1.85, -0.18);
  rider.add(visor);

  // Legs and arms are simple shapes to keep mobile rendering fast.
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.07, 0.34, 3, 6), pants
    );
    leg.position.set(side * 0.13, 1.03, 0.35);
    leg.rotation.x = -0.85;
    rider.add(leg);

    const arm = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.055, 0.32, 3, 6), jacket
    );
    arm.position.set(side * 0.2, 1.53, -0.24);
    arm.rotation.x = -1.05;
    arm.rotation.z = side * -0.22;
    rider.add(arm);
  }

  root.userData = {
    chassis,
    frontAssembly,
    frontWheel,
    rearWheel,
    rider,
    riderPivot
  };

  return root;
}

function addBuilding(x, z, width, height, depth, color) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  scene.add(group);

  const wall = makeMaterial(color, 0.88);
  const roof = makeMaterial("#424750", 0.9);
  const glass = makeMaterial("#87b8d0", 0.35, 0.1);
  const doorMat = makeMaterial("#44382e", 0.9);

  addBox(group, wall, 0, height / 2, 0, width, height, depth);
  addBox(group, roof, 0, height + 0.15, 0, width + 0.2, 0.3, depth + 0.2);

  const floors = Math.max(1, Math.floor(height / 1.5));
  const columns = Math.max(1, Math.floor(width / 1.2));

  for (let floor = 0; floor < floors; floor++) {
    for (let col = 0; col < columns; col++) {
      const wx = -width / 2 + (col + 0.5) * width / columns;
      const wy = 0.8 + floor * 1.35;

      if (wy > height - 0.3) continue;

      addBox(
        group, glass, wx, wy, -depth / 2 - 0.012,
        Math.min(0.5, width / columns * 0.48), 0.55, 0.035
      );
    }
  }

  addBox(group, doorMat, 0, 0.85, -depth / 2 - 0.025, 0.55, 1.7, 0.05);
}

function addTree(x, z, scale = 1) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.scale.setScalar(scale);
  scene.add(group);

  addCylinder(
    group, makeMaterial("#755037"), 0, 1.1, 0, 0.19, 2.2, 7
  );

  const leaves = makeMaterial(
    ["#3f7950", "#4f8d52", "#588b46"][Math.floor(Math.random() * 3)]
  );

  for (let i = 0; i < 3; i++) {
    const crown = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.95 - i * 0.12, 1), leaves
    );
    crown.position.set(0, 2.15 + i * 0.5, 0);
    crown.castShadow = true;
    group.add(crown);
  }
}

function addRoadSegment(z, length, width = 14) {
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length),
    makeMaterial("#343a41", 0.96)
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.015, z);
  road.receiveShadow = true;
  scene.add(road);

  const shoulderMat = makeMaterial("#c4c3ae");
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Mesh(
      new THREE.PlaneGeometry(0.65, length),
      shoulderMat
    );
    shoulder.rotation.x = -Math.PI / 2;
    shoulder.position.set(side * (width / 2 - 0.3), 0.025, z);
    scene.add(shoulder);
  }

  const lineMat = makeMaterial("#f1e8c8");
  const dashCount = Math.floor(length / 7);

  for (let i = 0; i < dashCount; i++) {
    const dash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.13, 3.2), lineMat
    );
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.03, z - length / 2 + i * 7 + 2);
    scene.add(dash);
  }
}

function buildWorld() {
  scene.background = new THREE.Color("#9dcae7");
  scene.fog = new THREE.Fog("#9dcae7", 95, 300);

  const hemi = new THREE.HemisphereLight("#e9f6ff", "#75805f", 2.0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight("#fff1d7", 2.5);
  sun.position.set(-35, 65, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -45;
  sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 45;
  sun.shadow.camera.bottom = -45;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 1200),
    makeMaterial("#739565", 1)
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  scene.add(ground);

  // Long road through the town and into the countryside.
  addRoadSegment(0, 600, 14);

  // Side roads in the town.
  for (const x of [-42, 42]) {
    const sideRoad = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 220),
      makeMaterial("#45494c")
    );
    sideRoad.rotation.x = -Math.PI / 2;
    sideRoad.rotation.z = Math.PI / 2;
    sideRoad.position.set(x, 0.01, -35);
    scene.add(sideRoad);
  }

  // City blocks close to the starting area.
  const buildingColors = [
    "#c7b6a0", "#b8c2c8", "#d4c7ac",
    "#a9b6a7", "#c5a59b", "#a9b9c9"
  ];

  for (let z = -90; z <= 90; z += 23) {
    for (const side of [-1, 1]) {
      const x = side * (18 + Math.random() * 5);
      const width = 8 + Math.random() * 7;
      const height = 6 + Math.random() * 17;
      const depth = 10 + Math.random() * 8;

      addBuilding(
        x, z + Math.random() * 5,
        width, height, depth,
        buildingColors[Math.floor(Math.random() * buildingColors.length)]
      );
    }
  }

  // Shops and houses farther along the road.
  for (let z = 110; z < 285; z += 19) {
    for (const side of [-1, 1]) {
      if (Math.random() > 0.7) continue;

      const x = side * (22 + Math.random() * 40);
      addBuilding(
        x, z + Math.random() * 8,
        7 + Math.random() * 8,
        3.5 + Math.random() * 4,
        8 + Math.random() * 9,
        buildingColors[Math.floor(Math.random() * buildingColors.length)]
      );
    }
  }

  // Trees lining the outskirts and countryside.
  for (let z = -260; z <= 300; z += 11) {
    for (const side of [-1, 1]) {
      const distance = z < 100 ? 34 + Math.random() * 18 : 23 + Math.random() * 60;
      addTree(
        side * distance,
        z + Math.random() * 8,
        0.75 + Math.random() * 0.65
      );
    }
  }

  // Distant hills create a horizon instead of an empty plane.
  const hillMat = makeMaterial("#6c926b", 1);

  for (let i = 0; i < 26; i++) {
    const hill = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      hillMat
    );
    const side = i % 2 === 0 ? -1 : 1;
    hill.position.set(
      side * (150 + Math.random() * 100),
      -8 + Math.random() * 4,
      -280 + Math.random() * 580
    );
    hill.scale.set(
      45 + Math.random() * 50,
      20 + Math.random() * 30,
      45 + Math.random() * 45
    );
    scene.add(hill);
  }

  // Roadside lamp posts near town.
  const poleMat = makeMaterial("#525e67", 0.5, 0.5);
  const lampMat = makeMaterial("#fff1c2", 0.4, 0.1);

  for (let z = -80; z < 100; z += 22) {
    for (const side of [-1, 1]) {
      const x = side * 9;

      addCylinder(scene, poleMat, x, 2.3, z, 0.07, 4.6, 7);
      addBox(scene, poleMat, x - side * 0.5, 4.5, z, 1.1, 0.07, 0.07);
      addBox(scene, lampMat, x - side * 1.0, 4.42, z, 0.25, 0.12, 0.2);
    }
  }
}

function startWorld() {
  if (animationStarted) return;
  animationStarted = true;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    69, innerWidth / innerHeight, 0.1, 800
  );

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance"
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  if ("outputColorSpace" in renderer) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  $("#game").appendChild(renderer.domElement);

  clock = new THREE.Clock();
  buildWorld();

  scooter = makeScooter("#ff8a24");
  scene.add(scooter);

  camera.position.set(0, 3.1, 6);
  camera.lookAt(0, 1, -3);

  // Make the initial camera view show a large scooter.
  renderer.render(scene, camera);

  lastFrame = performance.now();
  requestAnimationFrame(animate);
}

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrame) / 1000, 0.035);
  lastFrame = now;

  if (!dt || !renderer) return;

  updatePhysics(dt);
  updateLocalScooter(dt);
  updateRemotePlayers(dt);
  updateCamera(dt);
  updateHUD();

  if (socket?.connected) {
    networkTimer += dt;
    if (networkTimer >= 0.1) {
      networkTimer = 0;
      socket.emit("move", {
        x: physics.x,
        z: physics.z,
        rot: physics.heading,
        speed: physics.speed,
        wheelie: physics.wheelie
      });
    }

    saveTimer += dt;
    if (saveTimer >= 5) {
      saveTimer = 0;
      socket.emit("save_state", {
        x: physics.x,
        z: physics.z,
        rotation: physics.heading
      });
    }
  }

  renderer.render(scene, camera);
}

function updatePhysics(dt) {
  const maxSpeed = 28; // simulation units per second

  if (keys.gas) {
    physics.speed += 9 * dt;
  } else if (keys.brake) {
    physics.speed -= 19 * dt;
  } else {
    physics.speed -= 2.2 * dt;
  }

  physics.speed = clamp(physics.speed, 0, maxSpeed);

  const steerInput =
    (keys.left ? 1 : 0) - (keys.right ? 1 : 0);

  physics.steering = lerp(
    physics.steering,
    steerInput,
    Math.min(1, dt * 7)
  );

  const speedFactor = 0.35 + physics.speed / maxSpeed;
  physics.heading += physics.steering * speedFactor * 0.95 * dt;

  // Wheelie pitch is an angle, in radians.
  const targetWheelie = keys.wheelie && physics.speed > 2 ? 0.58 : 0;

  if (keys.wheelie && physics.speed > 2) {
    physics.wheelieVelocity += 1.65 * dt;
  } else {
    physics.wheelieVelocity -= 2.5 * dt;
  }

  physics.wheelieVelocity = clamp(
    physics.wheelieVelocity, -1.4, 1.4
  );

  // Small steering corrections help balance the wheelie.
  const steeringBalance = physics.steering * 0.12;
  const balanceTarget = clamp(
    targetWheelie - steeringBalance,
    0, 0.68
  );

  physics.wheelie = lerp(
    physics.wheelie,
    balanceTarget,
    Math.min(1, dt * (keys.wheelie ? 2.6 : 4.2))
  );

  // Gentle suspension bounce, more noticeable at high speed.
  physics.lean = lerp(
    physics.lean,
    -physics.steering * 0.22,
    Math.min(1, dt * 5)
  );

  physics.x += Math.sin(physics.heading) * physics.speed * dt;
  physics.z -= Math.cos(physics.heading) * physics.speed * dt;

  // The world is open; gently keep riders within the playable area.
  physics.x = clamp(physics.x, -180, 180);
  physics.z = clamp(physics.z, -420, 420);
}

function updateLocalScooter(dt) {
  if (!scooter) return;

  scooter.position.set(physics.x, 0, physics.z);
  scooter.rotation.y = physics.heading;
  scooter.rotation.z = physics.lean;

  const parts = scooter.userData;
  parts.chassis.rotation.x = -physics.wheelie;

  // Front fork moves upward with the front of the scooter.
  parts.frontAssembly.rotation.x = -physics.wheelie * 0.7;

  // Subtle visual suspension movement.
  const bounce = Math.sin(performance.now() * 0.012) *
    0.018 * (physics.speed / 28);

  parts.chassis.position.y = bounce;
  parts.rider.rotation.z = -physics.lean * 0.45;
}

function updateRemotePlayers(dt) {
  for (const [id, mesh] of remotePlayers) {
    const target = remoteTargets.get(id);
    if (!target) continue;

    const alpha = Math.min(1, dt * 10);
    mesh.position.x = lerp(mesh.position.x, target.x, alpha);
    mesh.position.z = lerp(mesh.position.z, target.z, alpha);

    // Smooth rotation through the shortest angle.
    let delta = target.rot - mesh.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    mesh.rotation.y += delta * alpha;

    if (mesh.userData.chassis) {
      mesh.userData.chassis.rotation.x =
        lerp(mesh.userData.chassis.rotation.x, -target.wheelie, alpha);
    }
  }
}

function updateCamera(dt) {
  if (!camera || !scooter) return;

  const heading = physics.heading;
  const followDistance = 4.5;
  const followHeight = 2.15;

  const desiredPosition = new THREE.Vector3(
    physics.x - Math.sin(heading) * followDistance,
    followHeight,
    physics.z + Math.cos(heading) * followDistance
  );

  camera.position.lerp(
    desiredPosition,
    Math.min(1, dt * 5.5)
  );

  const lookTarget = new THREE.Vector3(
    physics.x + Math.sin(heading) * 1.5,
    1.1 + physics.wheelie * 0.5,
    physics.z - Math.cos(heading) * 3
  );

  camera.lookAt(lookTarget);
}

function updateHUD() {
  $("#speed").textContent = Math.round(physics.speed * 5);

  const balance = clamp(
    1 - Math.abs(physics.wheelie - 0.45) / 0.65,
    0, 1
  );

  $("#balanceFill").style.width = `${balance * 100}%`;
  $("#balanceFill").style.background =
    balance > 0.55 ? "#65dfa3" : "#ffc16b";

  $("#balanceText").textContent =
    physics.wheelie > 0.12 ? "Wheelie aktiv" : "Bereit";

  $("#stuntBadge").hidden = physics.wheelie < 0.25;
}

function setKey(key, value) {
  if (!(key in keys)) return;
  keys[key] = value;
}

document.querySelectorAll("[data-key]").forEach((button) => {
  const key = button.dataset.key;

  const down = (event) => {
    event.preventDefault();
    setKey(key, true);
    button.classList.add("active");

    try {
      button.setPointerCapture(event.pointerId);
    } catch (_) {}
  };

  const up = (event) => {
    event.preventDefault();
    setKey(key, false);
    button.classList.remove("active");
  };

  button.addEventListener("pointerdown", down);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("lostpointercapture", () => {
    setKey(key, false);
    button.classList.remove("active");
  });
});

function keyboardKey(event, value) {
  const map = {
    ArrowUp: "gas",
    w: "gas",
    ArrowDown: "brake",
    s: "brake",
    ArrowLeft: "left",
    a: "left",
    ArrowRight: "right",
    d: "right",
    " ": "wheelie"
  };

  const key = map[event.key];
  if (!key) return;

  event.preventDefault();
  setKey(key, value);
}

addEventListener("keydown", (event) => keyboardKey(event, true));
addEventListener("keyup", (event) => keyboardKey(event, false));

function releaseControls() {
  for (const key of Object.keys(keys)) keys[key] = false;
  document.querySelectorAll("[data-key]").forEach((button) => {
    button.classList.remove("active");
  });
}

addEventListener("blur", releaseControls);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseControls();
});

$("#logoutBtn").addEventListener("click", async () => {
  releaseControls();

  try {
    await api("/api/logout");
  } catch (error) {
    console.warn("Logout request failed:", error);
  }

  if (socket) socket.disconnect();
  location.reload();
});

addEventListener("resize", () => {
  if (!renderer || !camera) return;

  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

restoreSession();
