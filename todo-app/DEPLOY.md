# Oracle Cloud(Always Free) 배포 가이드 — systemd + Caddy, Docker 없음

구성: `인터넷 → Caddy(HTTPS 자동, 80/443) → Node 앱(127.0.0.1:3000, systemd) → SQLite 파일`

> Oracle 무료 티어의 사양·한도·정책은 바뀔 수 있습니다. 가입 전에 Oracle 공식 “Always Free” 안내를 확인하세요.
> 특히 사용량이 매우 적은 무료 인스턴스는 회수될 수 있다는 정책이 있으니, 백업(6번)을 꼭 켜 두세요.

## 1. 인스턴스 만들기 (OCI 콘솔)
1. Compute → Instances → **Create instance**
2. Image: **Ubuntu 22.04 또는 24.04**
3. Shape: **Always Free 대상** 표시가 붙은 것 (예: Ampere `VM.Standard.A1.Flex` 1 OCPU / 6GB, 또는 AMD `E2.1.Micro`).
   A1은 “Out of capacity” 오류가 자주 나면 시간을 두고 다시 시도하거나 Micro를 쓰세요. 이 앱은 아주 가벼워서 Micro로도 충분합니다.
4. SSH 키를 등록(또는 생성 후 다운로드)하고 생성.
5. (권장) Networking → **Reserved public IP** 를 만들어 인스턴스에 연결하면 IP가 바뀌지 않습니다.

## 2. 포트 열기 — 두 군데 모두 열어야 합니다
**(a) OCI 콘솔:** VCN → Security List(또는 NSG) → **Ingress Rule 추가**
Source `0.0.0.0/0`, TCP, 포트 `80` 그리고 `443` (규칙 2개)

**(b) 서버 안의 방화벽:** Oracle의 Ubuntu 이미지는 iptables가 80/443을 막고 있습니다.
```bash
sudo iptables -L INPUT --line-numbers          # REJECT 규칙의 번호를 확인 (보통 6)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y iptables-persistent     # 물으면 Yes
sudo netfilter-persistent save
```
(REJECT 규칙의 **앞**에 들어가야 합니다. 22번(SSH) 규칙은 건드리지 마세요.)

## 3. 무료 도메인 (DuckDNS)
duckdns.org 로그인 → 이름 만들기(예: `mytodo`) → 인스턴스의 공용 IP 입력 → update.
확인: `nslookup mytodo.duckdns.org` 결과가 서버 IP인지.

## 4. Node 설치 (Node 22.5 이상 필요 — 내장 SQLite 사용)
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # v24.x
which node       # /usr/bin/node 여야 함 (다르면 todo-app.service 의 ExecStart 경로 수정)
```

## 5. 앱 설치 & 서비스 등록
내 PC에서 `todo-app` 폴더를 서버 홈으로 복사합니다 (예: `scp -i 키 -r todo-app ubuntu@서버IP:~`).
서버에서:
```bash
# 전용 사용자(로그인 불가) + 코드 위치
sudo useradd --system --home /var/lib/todo-app --shell /usr/sbin/nologin todo
sudo mkdir -p /opt/todo-app
sudo cp -r ~/todo-app/{server.js,backup.js,backup.sh,package.json,public} /opt/todo-app/
sudo chmod +x /opt/todo-app/backup.sh

# 설정 파일 (필요하면 AUTH_USER / AUTH_PASS 입력)
sudo cp ~/todo-app/deploy/todo-app.env.example /etc/todo-app.env
sudo chown root:todo /etc/todo-app.env && sudo chmod 640 /etc/todo-app.env
sudo nano /etc/todo-app.env

# 서비스 등록 & 시작
sudo cp ~/todo-app/deploy/todo-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now todo-app
systemctl status todo-app            # active (running) 확인
curl -s localhost:3000/api/state | head -c 100
```

**Caddy(HTTPS) 설치:**
```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo cp ~/todo-app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # mytodo.duckdns.org 를 내 도메인으로 수정
sudo systemctl reload caddy
```
1분쯤 뒤 `https://내도메인` 접속. (인증서 발급이 안 되면 `journalctl -u caddy -n 50` — 대부분 2번의 포트나 3번의 DNS 문제입니다.)

## 6. 매일 백업
```bash
sudo cp ~/todo-app/deploy/todo-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now todo-backup.timer
sudo systemctl start todo-backup.service        # 지금 한 번 테스트
sudo ls /var/lib/todo-app/backups
```
14일치가 `/var/lib/todo-app/backups` 에 쌓입니다. 서버가 통째로 사라질 수 있으니 가끔 내려받아 두세요:
```bash
# 서버에서: 최신 백업을 홈으로 복사
sudo cp "$(ls -t /var/lib/todo-app/backups/todo-*.db | head -1)" ~/latest.db && sudo chown $USER ~/latest.db
# 내 PC에서: 내려받기
scp -i 키 ubuntu@서버IP:~/latest.db .
```

## 7. 업데이트(코드 수정 후 재배포)
```bash
sudo cp -r ~/todo-app/{server.js,backup.js,backup.sh,package.json,public} /opt/todo-app/
sudo systemctl restart todo-app
```
데이터(`/var/lib/todo-app/todo.db`)는 그대로 유지됩니다.

## 자주 쓰는 명령
```bash
systemctl status todo-app          # 상태
journalctl -u todo-app -f          # 앱 로그 실시간
sudo systemctl restart todo-app    # 재시작
journalctl -u caddy -n 50          # HTTPS/도메인 문제
```

## 보안 메모
- 로그인이 없으면 주소를 아는 사람은 누구나 수정할 수 있습니다. 주소를 공유하지 않으면 사실상 안전하지만, `/etc/todo-app.env` 에 `AUTH_USER`/`AUTH_PASS` 를 넣고 `sudo systemctl restart todo-app` 하면 브라우저 비밀번호 창이 켜집니다. (HTTPS 위에서만 쓰세요.)
- 앱은 `127.0.0.1` 에만 열려 있어서 외부에서는 반드시 Caddy(HTTPS)를 거칩니다.
- 가끔 `sudo apt update && sudo apt upgrade` 로 OS 업데이트를 하세요.
