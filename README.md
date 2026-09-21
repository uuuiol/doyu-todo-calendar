# DoYu Todo Calendar

날짜별 할 일, 카테고리(색상), 마감일(D-day)을 관리하는 개인용 Todo 캘린더.

- `todo-app/` — 백엔드(Node + SQLite, 의존성 없음) + 프런트(`public/index.html`)
  - 실행: `cd todo-app && node server.js` → http://localhost:3000 (Node 22.5+)
  - 배포: `todo-app/DEPLOY.md` (Oracle Cloud + systemd + Caddy)
- `todo-calendar.html` — 백엔드 없이 동작하는 브라우저 저장(localStorage) 버전
- `todo-design.html` — 초기 디자인 시안
- `*.png` — 디자인 스크린샷
