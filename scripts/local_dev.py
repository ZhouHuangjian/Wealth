#!/usr/bin/env python3
"""Run Wealth locally without Docker or changing any global service.

Private configuration is read from .env, never printed. PostgreSQL data, process
state and local logs live under .runtime. This is a localhost development entry
point, not an Internet deployment. PostgreSQL 18 and Node must already exist.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import quote
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / ".runtime"
STATE = RUNTIME / "local-services.json"
DATABASES = {
    "wealth",
    "wealth_test",
    "wealth_ui_test",
    "wealth_restore_source_test",
    "wealth_restore_target_test",
}
ADMIN_ROLE = "wealth_local_admin"
PORT = 55432


def load_env(create=False):
    path = ROOT / ".env"
    if not path.exists():
        if not create:
            raise RuntimeError("缺少 .env；先运行 local_dev.py init 或 start")
        content = (ROOT / ".env.example").read_text()
        for name in (
            "POSTGRES_PASSWORD",
            "DB_OWNER_PASSWORD",
            "DB_APP_PASSWORD",
            "RABBITMQ_PASSWORD",
            "DJANGO_SECRET_KEY",
        ):
            lines = content.splitlines()
            content = (
                "\n".join(
                    f"{name}={secrets.token_hex(32)}"
                    if line.startswith(name + "=")
                    else line
                    for line in lines
                )
                + "\n"
            )
        with path.open("x") as output:
            output.write(content)
        path.chmod(0o600)
    values = dict(os.environ)
    for line in path.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    for name in (
        "POSTGRES_PASSWORD",
        "DB_OWNER_PASSWORD",
        "DB_APP_PASSWORD",
        "DJANGO_SECRET_KEY",
    ):
        if not values.get(name) or "CHANGE_ME" in values[name]:
            raise RuntimeError(f".env 的 {name} 尚未设置独立随机值")
    if path.stat().st_mode & 0o077:
        raise RuntimeError(".env 权限过宽，请先 chmod 600 .env")
    return values


def python_path():
    candidate = (
        ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    )
    if not candidate.exists():
        raise RuntimeError("本地 Python 环境未创建；先运行 local_dev.py init")
    return candidate


def pg_bin(values=None):
    values = values or load_env()
    choices = [
        values.get("WEALTH_PG_BIN"),
        "/opt/homebrew/opt/postgresql@18/bin",
        "/usr/local/opt/postgresql@18/bin",
        "/usr/lib/postgresql/18/bin",
    ]
    found = shutil.which("pg_ctl")
    if found:
        choices.append(str(Path(found).parent))
    for choice in choices:
        if choice and (Path(choice) / "pg_ctl").is_file():
            version = subprocess.run(
                [str(Path(choice) / "postgres"), "--version"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            if " 18." in version:
                return Path(choice)
    raise RuntimeError(
        "找不到 PostgreSQL 18；安装后设置 WEALTH_PG_BIN，或使用 Docker 启动入口"
    )


def backend_env(database="wealth", media=None, *, owner=False):
    if database not in DATABASES:
        raise RuntimeError("只允许项目明确声明的本地数据库")
    env = load_env()
    user = "wealth_owner" if owner else "wealth_app"
    password = env["DB_OWNER_PASSWORD"] if owner else env["DB_APP_PASSWORD"]
    env["DATABASE_URL"] = (
        f"postgresql://{user}:{quote(password, safe='')}@127.0.0.1:{PORT}/{database}"
    )
    env["DATABASE_URL_ADMIN"] = (
        f"postgresql://wealth_owner:{quote(env['DB_OWNER_PASSWORD'], safe='')}@127.0.0.1:{PORT}/{database}"
    )
    env["DJANGO_SETTINGS_MODULE"] = "config.settings"
    env["DJANGO_DEBUG"] = "1"
    env["DJANGO_ALLOWED_HOSTS"] = "localhost,127.0.0.1,testserver"
    port = env.get("WEALTH_LOCAL_PORT", env.get("WEALTH_PORT", "8000"))
    env["WEALTH_PORT"] = port
    env["DJANGO_CSRF_TRUSTED_ORIGINS"] = (
        f"http://127.0.0.1:{port},http://localhost:{port},http://127.0.0.1:5173,http://localhost:5173"
    )
    env["PRIVATE_MEDIA_ROOT"] = str(media or ROOT / ".private-media")
    if database != "wealth":
        env["WEALTH_TESTING"] = "1"
    return env


def manage(database, *arguments, media=None, owner=False, **kwargs):
    return subprocess.run(
        [str(python_path()), "manage.py", *arguments],
        cwd=ROOT / "backend",
        env=backend_env(database, media, owner=owner),
        check=True,
        **kwargs,
    )


def admin_connection(database="postgres"):
    import psycopg

    env = load_env()
    return psycopg.connect(
        host="127.0.0.1",
        port=PORT,
        dbname=database,
        user=ADMIN_ROLE,
        password=env["POSTGRES_PASSWORD"],
        autocommit=True,
    )


def configure_database(name, *, marker=None):
    if name not in DATABASES:
        raise RuntimeError("未允许的数据库名称")
    from psycopg import sql

    with admin_connection() as connection:
        exists = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname=%s", [name]
        ).fetchone()
        if not exists:
            connection.execute(
                sql.SQL("CREATE DATABASE {} OWNER wealth_owner").format(
                    sql.Identifier(name)
                )
            )
            if marker:
                connection.execute(
                    sql.SQL("COMMENT ON DATABASE {} IS {}").format(
                        sql.Identifier(name), sql.Literal(marker)
                    )
                )
        connection.execute(
            sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(
                sql.Identifier(name)
            )
        )
        connection.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO wealth_owner, wealth_app").format(
                sql.Identifier(name)
            )
        )
    with admin_connection(name) as connection:
        connection.execute("ALTER SCHEMA public OWNER TO wealth_owner")
        connection.execute("REVOKE ALL ON SCHEMA public FROM PUBLIC")
        connection.execute("GRANT USAGE ON SCHEMA public TO wealth_app")
        connection.execute(
            "ALTER DEFAULT PRIVILEGES FOR ROLE wealth_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wealth_app"
        )
        connection.execute(
            "ALTER DEFAULT PRIVILEGES FOR ROLE wealth_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wealth_app"
        )
        connection.execute(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wealth_app"
        )
        connection.execute(
            "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wealth_app"
        )


def setup_dependencies():
    requirements = ROOT / "backend/requirements.txt"
    requirements_hash = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = RUNTIME / "python-dependencies.sha256"
    if not (ROOT / ".venv").exists():
        if sys.version_info < (3, 12):
            raise RuntimeError("本地开发需要 Python 3.12 或更高版本；容器使用 3.13")
        subprocess.run([sys.executable, "-m", "venv", str(ROOT / ".venv")], check=True)
    if not marker.exists() or marker.read_text() != requirements_hash:
        subprocess.run(
            [str(python_path()), "-m", "pip", "install", "-r", str(requirements)],
            check=True,
        )
        marker.write_text(requirements_hash)


def _port_open(port):
    with socket.socket() as client:
        client.settimeout(0.5)
        return client.connect_ex(("127.0.0.1", port)) == 0


def initialize():
    os.umask(0o077)
    RUNTIME.mkdir(exist_ok=True, mode=0o700)
    env = load_env(create=True)
    binaries = pg_bin(env)
    setup_dependencies()
    # Bootstrap created the local venv; use it to obtain psycopg without a global install.
    if Path(
        sys.executable
    ).absolute() != python_path().absolute() and not os.environ.get(
        "WEALTH_LOCAL_REEXEC"
    ):
        child_env = dict(os.environ, WEALTH_LOCAL_REEXEC="1")
        subprocess.run(
            [str(python_path()), str(Path(__file__).resolve()), "init"],
            env=child_env,
            check=True,
        )
        return
    data = RUNTIME / "pgdata"
    password_file = RUNTIME / "pg-password"
    if not (data / "PG_VERSION").exists():
        if _port_open(PORT):
            raise RuntimeError("55432 已被其他服务占用，未创建或修改任何外部数据库")
        password_file.write_text(env["POSTGRES_PASSWORD"] + "\n")
        password_file.chmod(0o600)
        subprocess.run(
            [
                str(binaries / "initdb"),
                "-D",
                str(data),
                "-U",
                ADMIN_ROLE,
                "--pwfile",
                str(password_file),
                "--auth-local=scram-sha-256",
                "--auth-host=scram-sha-256",
                "--encoding=UTF8",
                "--no-locale",
            ],
            check=True,
        )
    if (data / "PG_VERSION").read_text().strip() != "18":
        raise RuntimeError("本地数据目录不是 PostgreSQL 18；拒绝原地启动或升级")
    running = (
        subprocess.run(
            [str(binaries / "pg_ctl"), "-D", str(data), "status"], capture_output=True
        ).returncode
        == 0
    )
    if not running:
        if _port_open(PORT):
            raise RuntimeError("55432 已被非本项目服务占用；拒绝操作")
        sockets = RUNTIME / "sockets"
        sockets.mkdir(exist_ok=True, mode=0o700)
        subprocess.run(
            [
                str(binaries / "pg_ctl"),
                "-D",
                str(data),
                "-l",
                str(RUNTIME / "postgres.log"),
                "-o",
                f"-p {PORT} -h 127.0.0.1 -k {sockets}",
                "-w",
                "start",
            ],
            check=True,
        )
    from psycopg import sql

    with admin_connection() as connection:
        cluster_path = Path(
            connection.execute("SHOW data_directory").fetchone()[0]
        ).resolve()
        if cluster_path != data.resolve():
            raise RuntimeError("数据库数据目录不属于本项目，拒绝配置")
        for role, password in (
            ("wealth_owner", env["DB_OWNER_PASSWORD"]),
            ("wealth_app", env["DB_APP_PASSWORD"]),
        ):
            if not connection.execute(
                "SELECT 1 FROM pg_roles WHERE rolname=%s", [role]
            ).fetchone():
                connection.execute(
                    sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role))
                )
            connection.execute(
                sql.SQL(
                    "ALTER ROLE {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}"
                ).format(sql.Identifier(role), sql.Literal(password))
            )
    for database in ("wealth", "wealth_test"):
        configure_database(database)
        manage(database, "migrate", "--noinput", owner=True)
    print("本项目本地数据库与迁移已就绪；没有创建演示账户或财务记录。")


def build_frontend():
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("需要已安装的 Node.js/npm；未修改全局环境")
    subprocess.run([npm, "ci"], cwd=ROOT / "frontend", check=True)
    subprocess.run([npm, "run", "build"], cwd=ROOT / "frontend", check=True)


def _read_state():
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def _owned_supervisor(state):
    if not isinstance(state.get("pid"), int) or not state.get("token"):
        return False
    process = subprocess.run(
        ["ps", "-p", str(state["pid"]), "-o", "command="],
        capture_output=True,
        text=True,
    )
    command = process.stdout
    return (
        process.returncode == 0
        and str(Path(__file__).resolve()) in command
        and "supervise" in command
        and state["token"] in command
    )


def _start():
    state = _read_state()
    if _owned_supervisor(state):
        print(f"本地服务已运行：http://127.0.0.1:{state['port']}")
        return
    initialize()
    env = load_env()
    port = int(env.get("WEALTH_LOCAL_PORT", env.get("WEALTH_PORT", "8000")))
    if not 1024 <= port <= 65535 or _port_open(port):
        raise RuntimeError("网页端口无效或已被其他服务占用；没有终止已有进程")
    build_frontend()
    token = secrets.token_hex(16)
    with (RUNTIME / "supervisor.log").open("ab") as log:
        child = subprocess.Popen(
            [
                str(python_path()),
                str(Path(__file__).resolve()),
                "supervise",
                "--token",
                token,
            ],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
    for _ in range(50):
        if child.poll() is not None:
            raise RuntimeError("本地服务启动失败，查看 .runtime/supervisor.log")
        current = _read_state()
        if current.get("token") == token and _port_open(port):
            try:
                with urlopen(
                    f"http://127.0.0.1:{port}/api/health/", timeout=1
                ) as response:
                    healthy = json.load(response).get("status") == "ok"
            except Exception:
                healthy = False
            if healthy:
                print(
                    f"已启动：http://127.0.0.1:{port}；首次进入请创建自己的用户和账簿。"
                )
                print(
                    "停止应用：python3 scripts/local_dev.py stop；数据库保留运行与数据。"
                )
                return
        time.sleep(0.2)
    raise RuntimeError("启动等待超时，查看 .runtime/web.log；使用 status 检查进程")


def supervise(token):
    stop_requested = False

    def request_stop(*_):
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    env = backend_env()
    port = int(env.get("WEALTH_PORT", "8000"))
    (ROOT / ".private-media").mkdir(exist_ok=True, mode=0o700)
    with (
        (RUNTIME / "web.log").open("ab") as web_log,
        (RUNTIME / "tick.log").open("ab") as tick_log,
    ):
        web = subprocess.Popen(
            [
                str(python_path()),
                "-m",
                "gunicorn",
                "config.wsgi:application",
                "--bind",
                f"127.0.0.1:{port}",
                "--workers",
                "2",
                "--timeout",
                "120",
                "--log-level",
                "warning",
            ],
            cwd=ROOT / "backend",
            env=env,
            stdout=web_log,
            stderr=web_log,
            start_new_session=True,
        )
        state = {
            "pid": os.getpid(),
            "token": token,
            "web_pid": web.pid,
            "port": port,
            "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "tick_mode": "local durable outbox, every 30s",
        }
        STATE.write_text(json.dumps(state))
        tick = None
        next_tick = 0.0
        try:
            while not stop_requested and web.poll() is None:
                if tick and tick.poll() is not None:
                    state.update(
                        last_tick_exit=tick.returncode,
                        last_tick_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                    )
                    STATE.write_text(json.dumps(state))
                    tick = None
                    next_tick = time.monotonic() + 30
                if tick is None and time.monotonic() >= next_tick:
                    tick = subprocess.Popen(
                        [str(python_path()), "manage.py", "tick"],
                        cwd=ROOT / "backend",
                        env=env,
                        stdout=tick_log,
                        stderr=tick_log,
                        start_new_session=True,
                    )
                time.sleep(0.5)
        finally:
            for child in (tick, web):
                if child and child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=30)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
            if _read_state().get("token") == token:
                STATE.unlink(missing_ok=True)


def _stop():
    state = _read_state()
    if not _owned_supervisor(state):
        print("没有本启动器拥有的运行进程；未终止其他服务。")
        return
    os.kill(state["pid"], signal.SIGTERM)
    for _ in range(80):
        if not _owned_supervisor(state):
            print("本启动器的网页和周期任务已停止；数据库及账本保留。")
            return
        time.sleep(0.5)
    raise RuntimeError("服务仍在退出，请检查日志；未强行终止不明进程")


@contextlib.contextmanager
def _lifecycle_lock():
    RUNTIME.mkdir(exist_ok=True, mode=0o700)
    with (RUNTIME / "local-lifecycle.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("已有本地启动或停止操作正在进行，请等待其完成")
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def start():
    with _lifecycle_lock():
        _start()


def stop():
    with _lifecycle_lock():
        _stop()


def status():
    state = _read_state()
    active = _owned_supervisor(state)
    print(
        json.dumps(
            {
                "managed_web_running": active,
                "url": f"http://127.0.0.1:{state.get('port', 8000)}"
                if active
                else None,
                "database_port_listening": _port_open(PORT),
                "last_tick_at": state.get("last_tick_at"),
                "last_tick_exit": state.get("last_tick_exit"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=["init", "start", "stop", "status", "supervise"]
    )
    parser.add_argument("--token", help=argparse.SUPPRESS)
    parser.add_argument(
        "--port",
        type=int,
        help="Only bind the managed web process to this localhost port",
    )
    args = parser.parse_args()
    if args.port is not None:
        os.environ["WEALTH_LOCAL_PORT"] = str(args.port)
    os.umask(0o077)
    try:
        if args.action == "supervise":
            if not args.token:
                raise RuntimeError("supervise 只能由启动器调用")
            supervise(args.token)
        else:
            {"init": initialize, "start": start, "stop": stop, "status": status}[
                args.action
            ]()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"本地启动未完成：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
