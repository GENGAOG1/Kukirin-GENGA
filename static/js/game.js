
const authScreen = document.querySelector("#authScreen");
const gameScreen = document.querySelector("#gameScreen");
const authForm = document.querySelector("#authForm");
const authMessage = document.querySelector("#authMessage");

let authMode = "login";
let socket = null;
let scene = null;
let camera = null;
let renderer = null;
let scooter = null;
let animationStarted = false;

const keys = {
  gas: false,
  brake: false,
  left: false,
  right: false
};

let x = 0;
let z = 0;
let rotation = 0;
let speed = 0;
let playerId = null;
const otherPlayers = new Map();

function setAuthMode(mode) {
  authMode = mode;

  document.querySelector("#loginTab")
    .classList.toggle("selected", mode === "login");

  document.querySelector("#registerTab")
    .classList.toggle("selected", mode === "register");

  document.querySelector("#submitAuth").textContent =
    mode === "login" ? "Anmelden" : "Account erstellen";

  document.querySelector("#password").autocomplete =
    mode === "login" ? "current-password" : "new-password";

  authMessage.textContent = "";
}

document.querySelector("#loginTab").onclick =
  () => setAuthMode("login");

document.querySelector("#registerTab").onclick =
  () => setAuthMode("register");

async function api(path, data) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Anfrage fehlgeschlagen");
  }

  return result;
}

authForm.addEventListener("submit", async event => {
  event.preventDefault();

  const button = document.querySelector("#submitAuth");
  button.disabled = true;
  authMessage.textContent = "Bitte warten …";

  try {
    const result = await api(
      authMode === "login" ? "/api/login" : "/api/register",
      {
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value
      }
    );

    document.querySelector("#playerName").textContent =
      result.player.username;

    showGame(result.player);
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function showGame(player) {
  authScreen.hidden = true;
  gameScreen.hidden = false;

  document.querySelector("#coins").textContent =
    "🪙 " + (player.coins ?? 0);

  document.querySelector("#scooterName").textContent =
    player.equipped_scooter || "Starter";

  x = player.x ?? 0;
  z = player.z ?? 0;
  rotation = player.rotation ?? 0;

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
  });

  socket.on("welcome", data => {
    playerId = data.id;
    (data.players || []).forEach(addRemote);
  });

  socket.on("players_update", list => {
    list.forEach(addRemote);
  });

  socket.on("player_left", data => {
    const item = otherPlayers.get(data.id);
    if (item) {
      scene.remove(item);
      otherPlayers.delete(data.id);
    }
  });

  socket.on("connect_error", () => {
    document.querySelector("#gameMessage").textContent =
      "Multiplayer-Verbindung wird erneut versucht …";
  });
}

function addRemote(player) {
  if (!scene || player.id === playerId) return;

  let mesh = otherPlayers.get(player.id);

  if (!mesh) {
    mesh = makeScooter(player.color || "#27c4ff");
    scene.add(mesh);
    otherPlayers.set(player.id, mesh);
  }

  mesh.position.set(player.x || 0, 0, player.z || 0);
  mesh.rotation.y = player.rot || 0;
}

function material(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
}

function makeScooter(color) {
  const group = new THREE.Group();

  const frame = material(color);
  const dark = material("#171d25");
  const metal = material("#b6c3cc");

  function part(geometry, mat, px, py, pz) {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  }

  const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.15, 14);
  wheel.rotateZ(Math.PI / 2);

  part(wheel, dark, 0, 0.37, -0.8);
  part(wheel, dark, 0, 0.37, 0.8);
  part(new THREE.BoxGeometry(0.42, 0.13, 1.25),
    frame, 0, 0.72, 0);

  const stem = part(
    new THREE.CylinderGeometry(0.05, 0.07, 0.95, 8),
    metal, 0, 1.15, -0.52
  );
  stem.rotation.x = -0.3;

  part(new THREE.BoxGeometry(0.8, 0.08, 0.1),
    dark, 0, 1.62, -0.65);

  part(new THREE.CapsuleGeometry(0.22, 0.55, 4, 8),
    dark, 0, 1.65, 0.05);

  part(new THREE.SphereGeometry(0.2, 12, 8),
    material("#d5a37c"), 0, 2.12, 0.05);

  return group;
}

function startWorld() {
  if (animationStarted) return;
  animationStarted = true;

  const container = document.querySelector("#game");

  scene = new THREE.Scene();
  scene.background = new THREE.Color("#9bc8e8");
  scene.fog = new THREE.Fog("#9bc8e8", 60, 180);

  camera = new THREE.PerspectiveCamera(
    65, innerWidth / innerHeight, 0.1, 400
  );

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance"
  });

  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight("#e7f5ff", "#71805f", 2));

  const sun = new THREE.DirectionalLight("#fff2d8", 2.3);
  sun.position.set(-20, 40, 15);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    material("#78a96b")
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.1;
  scene.add(ground);

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 300),
    material("#343b46")
  );
  road.rotation.x = -Math.PI / 2;
  road.position.y = -0.04;
  scene.add(road);

  for (let pz = -145; pz < 150; pz += 10) {
    const dash = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.02, 4),
      material("#f6f3dd")
    );
    dash.position.set(0, 0, pz);
    scene.add(dash);
  }

  scooter = makeScooter("#ff7a18");
  scene.add(scooter);

  let lastTime = performance.now();
  let lastSend = 0;
  let lastSave = 0;

  function animate(now) {
    requestAnimationFrame(animate);

    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    speed += ((keys.gas ? 10 : 0) -
      (keys.brake ? 16 : 0)) * dt;

    if (!keys.gas && !keys.brake) {
      speed = Math.max(0, speed - 3 * dt);
    }

    speed = Math.max(0, Math.min(18, speed));

    rotation += ((keys.left ? 1 : 0) -
      (keys.right ? 1 : 0)) * dt * (1.5 + speed * 0.03);

    x += Math.sin(rotation) * speed * dt;
    z -= Math.cos(rotation) * speed * dt;
    x = Math.max(-7.5, Math.min(7.5, x));

    if (z < -140) z = 140;
    if (z > 145) z = -135;

    scooter.position.set(x, 0, z);
    scooter.rotation.y = rotation;

    camera.position.lerp(
      new THREE.Vector3(
        x - Math.sin(rotation) * 7,
        3.5,
        z + Math.cos(rotation) * 7
      ),
      Math.min(1, dt * 4)
    );

    camera.lookAt(x, 1, z - 2);

    document.querySelector("#speed").textContent =
      Math.round(speed * 5);

    if (socket?.connected && now - lastSend > 100) {
      socket.emit("move", {
        x, z, rot: rotation, speed
      });
      lastSend = now;
    }

    // Speichern wird später über einen authentifizierten
    // Server-Endpunkt ergänzt.
    lastSave = now;

    renderer.render(scene, camera);
  }

  requestAnimationFrame(animate);
}

document.querySelectorAll("[data-key]").forEach(button => {
  const key = button.dataset.key;

  const down = event => {
    event.preventDefault();
    keys[key] = true;
    button.classList.add("active");
  };

  const up = () => {
    keys[key] = false;
    button.classList.remove("active");
  };

  button.addEventListener("pointerdown", down);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("lostpointercapture", up);
});

addEventListener("keydown", event => {
  const map = {
    ArrowUp: "gas", w: "gas",
    ArrowDown: "brake", s: "brake",
    ArrowLeft: "left", a: "left",
    ArrowRight: "right", d: "right"
  };

  if (map[event.key]) keys[map[event.key]] = true;
});

addEventListener("keyup", event => {
  const map = {
    ArrowUp: "gas", w: "gas",
    ArrowDown: "brake", s: "brake",
    ArrowLeft: "left", a: "left",
    ArrowRight: "right", d: "right"
  };

  if (map[event.key]) keys[map[event.key]] = false;
});

document.querySelector("#logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", {});
  } finally {
    if (socket) socket.disconnect();
    location.reload();
  }
});

addEventListener("resize", () => {
  if (!renderer || !camera) return;

  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
