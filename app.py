
import json
import math
import os
import re
import threading

import libsql
from flask import Flask, jsonify, render_template, request, session
from flask_socketio import SocketIO, emit
from werkzeug.security import check_password_hash, generate_password_hash


# --------------------------------------------------
# Flask-Konfiguration
# --------------------------------------------------

app = Flask(__name__)

app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "local-dev-key-change-this"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
    MAX_CONTENT_LENGTH=32 * 1024,
)

socketio = SocketIO(
    app,
    cors_allowed_origins=None,
    async_mode="threading",
)

DEFAULT_SCOOTERS = ["Starter"]

_schema_lock = threading.Lock()
_schema_ready = False

# Enthält die momentan verbundenen Spieler dieses Serverprozesses.
online_players = {}
online_players_lock = threading.RLock()


# --------------------------------------------------
# Turso-Datenbank
# --------------------------------------------------

def get_db():
    """Öffnet eine Verbindung und erstellt bei Bedarf die Tabellen."""
    global _schema_ready

    url = os.environ.get("TURSO_DATABASE_URL")
    token = os.environ.get("TURSO_AUTH_TOKEN")

    if not url or not token:
        raise RuntimeError(
            "TURSO_DATABASE_URL oder TURSO_AUTH_TOKEN fehlt in den "
            "Render-Environment-Variablen."
        )

    conn = libsql.connect(database=url, auth_token=token)

    if not _schema_ready:
        try:
            with _schema_lock:
                if not _schema_ready:
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT NOT NULL,
                            username_key TEXT NOT NULL UNIQUE,
                            password_hash TEXT NOT NULL,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )
                    """)

                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS player_state (
                            user_id INTEGER PRIMARY KEY,
                            coins INTEGER NOT NULL DEFAULT 0,
                            owned_scooters_json TEXT NOT NULL
                                DEFAULT '["Starter"]',
                            inventory_json TEXT NOT NULL DEFAULT '[]',
                            upgrades_json TEXT NOT NULL DEFAULT '{}',
                            equipped_scooter TEXT NOT NULL DEFAULT 'Starter',
                            level INTEGER NOT NULL DEFAULT 1,
                            xp INTEGER NOT NULL DEFAULT 0,
                            x REAL NOT NULL DEFAULT 0,
                            z REAL NOT NULL DEFAULT 0,
                            rotation REAL NOT NULL DEFAULT 0,
                            FOREIGN KEY (user_id) REFERENCES users(id)
                        )
                    """)

                    conn.commit()
                    _schema_ready = True
        except Exception:
            conn.close()
            raise

    return conn


def get_saved_player(conn, user_id):
    """Liest das gespeicherte Profil eines Spielers."""
    row = conn.execute("""
        SELECT
            u.id,
            u.username,
            p.coins,
            p.owned_scooters_json,
            p.inventory_json,
            p.upgrades_json,
            p.equipped_scooter,
            p.level,
            p.xp,
            p.x,
            p.z,
            p.rotation
        FROM users AS u
        JOIN player_state AS p ON p.user_id = u.id
        WHERE u.id = ?
    """, (user_id,)).fetchone()

    if row is None:
        return None

    try:
        owned_scooters = json.loads(row[3])
        inventory = json.loads(row[4])
        upgrades = json.loads(row[5])
    except (TypeError, ValueError):
        owned_scooters = DEFAULT_SCOOTERS.copy()
        inventory = []
        upgrades = {}

    return {
        "id": row[0],
        "username": row[1],
        "coins": row[2],
        "owned_scooters": owned_scooters,
        "inventory": inventory,
        "upgrades": upgrades,
        "equipped_scooter": row[6],
        "level": row[7],
        "xp": row[8],
        "x": row[9],
        "z": row[10],
        "rotation": row[11],
    }


def logged_in_user_id():
    user_id = session.get("user_id")
    return user_id if isinstance(user_id, int) else None


# --------------------------------------------------
# Positionsdaten validieren und speichern
# --------------------------------------------------

def valid_position(data):
    if not isinstance(data, dict):
        return None

    try:
        x = float(data.get("x", 0))
        z = float(data.get("z", 0))
        rotation = float(data.get("rotation", data.get("rot", 0)))
    except (TypeError, ValueError, OverflowError):
        return None

    if not all(math.isfinite(v) for v in (x, z, rotation)):
        return None

    if abs(x) > 100000 or abs(z) > 100000 or abs(rotation) > 100000:
        return None

    return x, z, rotation


def save_position(user_id, position):
    conn = get_db()
    try:
        conn.execute("""
            UPDATE player_state
            SET x = ?, z = ?, rotation = ?
            WHERE user_id = ?
        """, (*position, user_id))
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------
# Seiten und API
# --------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/me")
def api_me():
    user_id = logged_in_user_id()

    if user_id is None:
        return jsonify(error="Bitte melde dich an."), 401

    conn = get_db()
    try:
        player = get_saved_player(conn, user_id)

        if player is None:
            session.clear()
            return jsonify(error="Account nicht gefunden."), 401

        return jsonify(player=player)
    finally:
        conn.close()


@app.post("/api/register")
def api_register():
    data = request.get_json(silent=True) or {}

    username = str(data.get("username", "")).strip()
    password = data.get("password", "")

    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", username):
        return jsonify(
            error=(
                "Der Benutzername muss 3–20 Zeichen haben und darf "
                "nur Buchstaben, Zahlen und _ enthalten."
            )
        ), 400

    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        return jsonify(
            error="Das Passwort muss zwischen 8 und 128 Zeichen lang sein."
        ), 400

    username_key = username.casefold()
    password_hash = generate_password_hash(password)

    conn = get_db()

    try:
        try:
            conn.execute(
                """
                INSERT INTO users (username, username_key, password_hash)
                VALUES (?, ?, ?)
                """,
                (username, username_key, password_hash),
            )

            user = conn.execute(
                """
                SELECT id, username
                FROM users
                WHERE username_key = ?
                """,
                (username_key,),
            ).fetchone()

            if user is None:
                conn.rollback()
                return jsonify(error="Registrierung fehlgeschlagen."), 500

            user_id = user[0]

            conn.execute(
                """
                INSERT INTO player_state (user_id, owned_scooters_json)
                VALUES (?, ?)
                """,
                (user_id, json.dumps(DEFAULT_SCOOTERS)),
            )

            conn.commit()

        except Exception as exc:
            conn.rollback()

            if "unique" in str(exc).lower():
                return jsonify(
                    error="Dieser Benutzername ist bereits vergeben."
                ), 409

            app.logger.exception("Registration failed")
            return jsonify(
                error="Registrierung gerade nicht möglich."
            ), 500

        session.clear()
        session["user_id"] = user_id

        player = get_saved_player(conn, user_id)
        return jsonify(player=player), 201

    finally:
        conn.close()


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}

    username = str(data.get("username", "")).strip()
    password = data.get("password", "")

    if not username or not isinstance(password, str):
        return jsonify(
            error="Benutzername oder Passwort ist falsch."
        ), 401

    conn = get_db()

    try:
        row = conn.execute(
            """
            SELECT id, password_hash
            FROM users
            WHERE username_key = ?
            """,
            (username.casefold(),),
        ).fetchone()

        if row is None or not check_password_hash(row[1], password):
            return jsonify(
                error="Benutzername oder Passwort ist falsch."
            ), 401

        session.clear()
        session["user_id"] = row[0]

        player = get_saved_player(conn, row[0])

        if player is None:
            session.clear()
            return jsonify(error="Account nicht gefunden."), 401

        return jsonify(player=player)

    finally:
        conn.close()


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.post("/api/save-position")
def api_save_position():
    user_id = logged_in_user_id()

    if user_id is None:
        return jsonify(error="Bitte melde dich erneut an."), 401

    position = valid_position(request.get_json(silent=True) or {})

    if position is None:
        return jsonify(error="Ungültige Position."), 400

    try:
        save_position(user_id, position)
    except Exception:
        app.logger.exception("Could not save player position")
        return jsonify(error="Position konnte nicht gespeichert werden."), 500

    return jsonify(ok=True)


# --------------------------------------------------
# Multiplayer-Helfer
# --------------------------------------------------

def public_player(player):
    """Gibt nur Daten weiter, die andere Spieler sehen müssen."""
    return {
        "id": player["id"],
        "username": player["username"],
        "x": player["x"],
        "z": player["z"],
        "rot": player["rot"],
        "speed": player["speed"],
        "wheelie": player["wheelie"],
    }


def broadcast_players():
    with online_players_lock:
        players = [
            public_player(player)
            for player in online_players.values()
        ]

    socketio.emit("players_update", players)


# --------------------------------------------------
# Socket.IO-Events
# --------------------------------------------------

@socketio.on("connect")
def socket_connect(auth=None):
    # Flask-Sitzung wird über den Socket.IO-Request-Kontext verwendet.
    return


@socketio.on("join_game")
def socket_join_game(data=None):
    user_id = logged_in_user_id()

    if user_id is None:
        emit("auth_required", {"message": "Bitte zuerst anmelden."})
        return

    conn = get_db()

    try:
        player = get_saved_player(conn, user_id)
    finally:
        conn.close()

    if player is None:
        emit("auth_required", {"message": "Account nicht gefunden."})
        return

    sid = request.sid

    new_player = {
        "id": sid,
        "user_id": user_id,
        "username": player["username"],
        "x": player["x"],
        "z": player["z"],
        "rot": player["rotation"],
        "speed": 0.0,
        "wheelie": 0.0,
    }

    with online_players_lock:
        # Derselbe Socket soll nicht doppelt hinzugefügt werden.
        online_players[sid] = new_player
        existing_players = [
            public_player(p)
            for p in online_players.values()
        ]

    emit("welcome", {
        "id": sid,
        "players": existing_players,
    })

    broadcast_players()


@socketio.on("move")
def socket_move(data):
    sid = request.sid
    user_id = logged_in_user_id()

    if user_id is None or not isinstance(data, dict):
        return

    position = valid_position(data)

    if position is None:
        return

    x, z, rotation = position

    try:
        speed = float(data.get("speed", 0))
    except (TypeError, ValueError, OverflowError):
        speed = 0.0

    try:
        wheelie = float(data.get("wheelie", 0))
    except (TypeError, ValueError, OverflowError):
        wheelie = 0.0

    if not math.isfinite(speed):
        speed = 0.0

    if not math.isfinite(wheelie):
        wheelie = 0.0

    speed = max(0.0, min(speed, 300.0))
    wheelie = max(0.0, min(wheelie, 0.68))

    with online_players_lock:
        player = online_players.get(sid)

        if player is None or player["user_id"] != user_id:
            return

        player.update({
            "x": x,
            "z": z,
            "rot": rotation,
            "speed": speed,
            "wheelie": wheelie,
        })

    broadcast_players()


@socketio.on("save_state")
def socket_save_state(data=None):
    user_id = logged_in_user_id()
    sid = request.sid

    if user_id is None:
        return

    position = valid_position(data)

    if position is None:
        return

    with online_players_lock:
        player = online_players.get(sid)

        if player is None or player["user_id"] != user_id:
            return

    try:
        save_position(user_id, position)
    except Exception:
        app.logger.exception("Could not save player position")


@socketio.on("disconnect")
def socket_disconnect(reason=None):
    sid = request.sid
    removed = False

    with online_players_lock:
        if sid in online_players:
            online_players.pop(sid, None)
            removed = True

    if removed:
        socketio.emit("player_left", {"id": sid})
        broadcast_players()


# --------------------------------------------------
# Start
# --------------------------------------------------

if __name__ == "__main__":
    socketio.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        debug=False,
    )
