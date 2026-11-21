"""在新的 Ubuntu 虚拟机中初始化单机部署包。"""

import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time


CONFIG_MARKER = "# LycanSync install.py\n"


def initialize_config():
    config = Path(".env")
    if config.exists():
        if not config.read_text().startswith(CONFIG_MARKER):
            sys.exit("检测到手动配置的 .env，请按 DEPLOY.md 管理此部署。")
        print("继续使用已有的 .env。")
        return

    # Compose 项目名固定，换目录解压不会隔离同一宿主上的数据库卷。
    for resource in ("volume", "container"):
        existing = subprocess.check_output(
            ["docker", resource, "ls", "-q", *(["-a"] if resource == "container" else []),
             "--filter", "label=com.docker.compose.project=lycansync-server"], text=True)
        if existing.strip():
            sys.exit("已有 LycanSync 部署资源。请从原部署目录继续，或恢复对应的 .env。")

    domain = input("访问域名（仅限内网测试时填虚拟机 IPv4）：").strip().lower()
    try:
        lan_ip = ipaddress.IPv4Address(domain)
    except ValueError:
        lan_ip = None
        label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
        if (len(domain) > 253 or not re.fullmatch(rf"{label}(?:\.{label})+", domain)
                or domain.rsplit(".", 1)[1].isdigit()):
            sys.exit("请填写完整域名或 IPv4，不含协议、端口或路径。")
    media_ip = lan_ip or ipaddress.IPv4Address(input("朋友可达的媒体入口 IPv4：").strip())
    if media_ip.is_loopback or media_ip.is_unspecified or media_ip.is_multicast:
        sys.exit("媒体入口必须是客户端可达的单播 IPv4。")

    compose_files = "compose.yaml:compose.lan.yaml" if lan_ip else "compose.yaml"
    settings = {"SERVER_DOMAIN": domain, "MEDIA_ADVERTISE_IP": str(media_ip),
                "POSTGRES_PASSWORD": secrets.token_hex(32), "LIVEKIT_API_SECRET": secrets.token_hex(32)}
    lines = Path(".env.example").read_text().splitlines()
    tmp = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=".", delete=False)
    try:
        with tmp:
            tmp.write(CONFIG_MARKER + f"COMPOSE_FILE={compose_files}\n")
            for line in lines:
                key = line.partition("=")[0]
                print(f"{key}={settings[key]}" if key in settings else line, file=tmp)
        os.link(tmp.name, config)
    finally:
        os.unlink(tmp.name)


def main():
    os.chdir(Path(__file__).resolve().parent)
    for name in ("api.jar", "livekit/livekit-server", "downloads/LycanSync-setup.exe", "downloads/latest.yml"):
        if not Path(name).is_file():
            sys.exit(f"缺少 {name}，请解压完整服务端发布包后重试。")
    compose = ["docker", "compose"]
    subprocess.run(compose + ["version"], check=True)
    initialize_config()
    subprocess.run(compose + ["config", "--quiet"], check=True)
    subprocess.run(compose + ["up", "-d", "--no-recreate"], check=True)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        probe = subprocess.run(compose + ["exec", "-T", "caddy", "wget", "-qO-", "-T", "3",
                                          "http://api:18080/actuator/health"], capture_output=True)
        if probe.returncode == 0 and json.loads(probe.stdout).get("status") == "UP":
            break
        time.sleep(2)
    else:
        sys.exit("本机 API 未就绪，请检查 docker compose ps 和 docker compose logs --tail=80 api。")

    print("本机 API 已就绪。下一步请按 QUICKSTART.md 激活服主，再邀请朋友。", flush=True)
    if sys.stdout.isatty():
        print("以下链接仅供服主首次激活使用。", flush=True)
        subprocess.run(compose + ["exec", "-T", "api", "sh", "-ec",
                       "if [ -f /var/bootstrap/admin-activation.txt ]; then cat /var/bootstrap/admin-activation.txt; "
                       "else echo '当前没有待用的激活文件。'; fi"], check=True)
    else:
        print("请在自己的终端查看首次激活链接：docker compose exec -T api cat /var/bootstrap/admin-activation.txt")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, EOFError, subprocess.CalledProcessError) as error:
        sys.exit(f"安装未完成：{error}")
