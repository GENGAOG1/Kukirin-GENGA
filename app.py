
import os
import time

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get(
    "SECRET_KEY", "dev-secret-change-before-production"
)

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
)

players = {}
MAX_COORD = 500
MAX_SPEED = 18


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def handle_connect():
    sid = request.sid
    colors = ["#ff7a18", "#27c4ff", "#a78bfa", "#35d07f"]

    player = {
        "id": sid,
        "name": f"Rider-{sid[:4].upper()}",
        "x": (len(players) % 5 - 2) * 2.5,
        "z": -4.0,
        "rot": 0.0,
        "speed": 0.0,
        "color": colors[len(players) % len(colors)],
    }

    players[sid] = player

    emit("welcome", {
        "id": sid,
        "players": list(players.values()),
    })

    emit("player_joined", player, broadcast=True, include_self=False)

    print(f"Spieler verbunden: {player['name']}")


@socketio.on("move")
def handle_move(data):
    player = players.get(request.sid)

    if player is None or not isinstance(data, dict):
        return

    try:
        x = float(data.get("x", player["x"]))
        z = float(data.get("z", player["z"]))
        rot = float(data.get("rot", player["rot"]))
        speed = float(data.get("speed", 0))
    except (ValueError, TypeError):
        return

    # Eingaben begrenzen
    player["x"] = max(-MAX_COORD, min(MAX_COORD, x))
    player["z"] = max(-MAX_COORD, min(MAX_COORD, z))
    player["rot"] = rot % (2 * 3.141592653589793)
    player["speed"] = max(0, min(MAX_SPEED, speed))
    player["updated"] = time.time()

    emit("players_update", list(players.values()), broadcast=True)


@socketio.on("disconnect")
def handle_disconnect(reason=None):
    player = players.pop(request.sid, None)

    if player:
        emit(
            "player_left",
            {"id": request.sid},
            broadcast=True,
        )
        print(f"Spieler getrennt: {player['name']}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))

    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        allow_unsafe_werkzeug=True,
    )
