# Centralized Bot Monitoring & Order Tracking Service

ตัวอย่างระบบควบคุมและติดตาม Bot instances จากศูนย์กลาง สร้างจาก `oxide-monitor-candidate-pack` โดยใช้ Node.js 22, TypeScript, Express, PostgreSQL 16 และ Docker Compose พร้อมหน้า dashboard แบบ static ที่เสิร์ฟจาก API

> ชุดนี้เป็น reference implementation สำหรับ local development/candidate evaluation เท่านั้น Simulator ที่ให้มามีข้อมูล in-memory และรองรับเพียง `start`, `stop`, `restart`, `status` ไม่เชื่อม Production และไม่ได้ติดตั้ง ZIP ลงเครื่อง bot จริง

## Architecture

```text
Browser dashboard ── REST / WebSocket ── Central API (Express)
                                             │        │
                             PostgreSQL ──────┘        └──── REST polling/commands ── Simulator
```

- Dashboard อ่าน overview, bot cards, orders, deployments และ audit ผ่าน REST และรับสัญญาณเปลี่ยนแปลงผ่าน WebSocket `/ws` (polling สำรองทุก 5 วินาที)
- API เป็น control plane กลาง บันทึกคำสั่ง/เหตุการณ์ลง PostgreSQL และเรียก simulator ผ่าน REST API
- Heartbeat ปัจจุบันจำลองด้วยการ sync รายชื่อ bot และ metrics จาก simulator ทุก `BOT_POLL_MS`; `last_heartbeat` ถูกบันทึกเมื่อ sync สำเร็จ
- Bot agent จริงควรเชื่อม API จากเครือข่ายของตนเอง ใช้ TLS และ token/mTLS, ส่ง heartbeat พร้อม version/metrics และ pull งานผ่าน authenticated claim endpoint
- Schema เก็บ bot, metrics, logs, commands, code packages, deployments, orders, order events, system settings และ audit trail

## Run

จาก root ของแพ็กเกจ:

```bash
cp .env.example .env
# ปรับ POSTGRES_PASSWORD ใน .env สำหรับเครื่องของคุณ
docker compose up --build
```

เปิด dashboard ที่ [http://localhost:3000](http://localhost:3000) และ API ที่ `http://localhost:3000/api/v1`; simulator อยู่ภายใน Compose network ที่ `simulator:8788`; PostgreSQL เปิด host port `55432`.

Compose จะ initialize `db/schema.sql` และ `db/seed.sql` ตอนสร้าง volume ใหม่เท่านั้น หากต้องการเริ่มข้อมูลใหม่ใน local demo ให้หยุดระบบและลบ volume ด้วย `docker compose down -v` แล้วรันใหม่ (ลบข้อมูลใน volume ดังกล่าว)

รันเฉพาะ simulator ตามวิธีเดิมของแพ็กเกจได้ด้วย `cd simulator && npm start` (กรณี local API ให้กำหนด `SIMULATOR_URL=http://localhost:8788`).

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health`, `/api/v1/overview` | Health และ summary online/active/standby/in progress/order counts/kill switch |
| GET | `/api/v1/bots`, `/api/v1/bots/:id` | Cards, metrics, recent commands, logs |
| POST | `/api/v1/bots/:id/commands` | `start`, `stop`, `restart`, `status`; รับ `Idempotency-Key` และ `X-Actor` |
| POST | `/api/v1/system/kill-switch` | `{ "enabled": true/false }`; เมื่อเปิดจะพยายาม stop bot ที่ online ทันที |
| POST/GET | `/api/v1/orders` | สร้าง order แบบ idempotent / list โดย filter `?status=QUEUED` |
| POST | `/api/v1/orders/:id/pay` | เปลี่ยน `PENDING_PAYMENT` เป็น `QUEUED` |
| POST | `/api/v1/orders/claim` | `{ "botId":"bot-01" }` เพื่อ claim งานแบบ atomic |
| POST | `/api/v1/orders/:id/complete` | `{ "status":"COMPLETED" }` หรือ `FAILED` จาก owner ของงาน |
| POST/GET | `/api/v1/deployments/packages` | อัปโหลด ZIP ด้วย multipart `file` และ `version`; list package |
| POST/GET | `/api/v1/deployments` | สร้าง deployment ด้วย `packageId`, optional `botId`; list history |
| GET/POST | `/api/v1/bots/:id/logs` | อ่าน/รับ log |
| GET | `/api/v1/audit` | Audit trail |
| WS | `/ws` | Events เช่น `bot.offline`, `order.updated`, `system.kill_switch` |

ตัวอย่าง request เพิ่มเติมอยู่ที่ [`examples/examples.http`](examples/examples.http).

## Order state machine

```text
PENDING_PAYMENT ── payment confirmed ──> QUEUED ── atomic claim ──> IN_PROGRESS ──> COMPLETED
                                                                         │       └──> FAILED
                                                                         ├─ lease expired ──> QUEUED (attempts remain) / FAILED
                                                                         └─ bot timeout ───> QUEUED (attempts remain) / FAILED
PENDING_PAYMENT ── business expiry worker (configure policy) ──> EXPIRED
```

`DELAYED` เป็นสถานะชั่วคราวใน timeout handling: บันทึก transition แล้วนำกลับ `QUEUED` หากยังไม่เกิน `max_attempts`; ถ้าเกินจะจบ `FAILED`. `EXPIRED` ถูกเตรียมไว้เป็น terminal state แต่ยังไม่เปิดอายุชำระเงินโดย default เพราะต้องกำหนด payment SLA ตามธุรกิจ

## แนวทางรับมือเคสสำคัญ 5 ข้อ

1. **Concurrency:** claim ใช้ transaction, `SELECT ... FOR UPDATE SKIP LOCKED`, lock bot และเปลี่ยน order เป็น `IN_PROGRESS` ใน transaction เดียว จึงมี worker หลายตัวแย่ง queue ได้โดยไม่รับงานซ้ำ
2. **Idempotency:** unique `external_order_id` และ `idempotency_key` ป้องกัน order ซ้ำ; command ใช้ unique `(bot_id,idempotency_key)`. ฝั่ง client ควรสร้าง key ใหม่ต่อ operation และ reuse key เมื่อ retry คำขอเดิม
3. **Retry:** timeout/lease คืนงานเข้าคิวเมื่อ attempts ยังไม่ถึง `max_attempts`; ใช้ `last_error`, events และ audit เพื่อสืบค้น; production ควรเพิ่ม exponential backoff+jitter, dead-letter queue และ policy แยก error ที่ retry ได้
4. **Bot timeout/lease:** heartbeat timeout ตั้งค่าได้; bot stale ถูก mark offline และงาน active ถูก requeue/fail; order lease ป้องกันงานค้างเมื่อ process หาย ทั้งสอง worker ทำซ้ำได้แบบ idempotent จาก status predicate
5. **Race condition:** ทุก transition สำคัญ lock order ด้วย `FOR UPDATE` และตรวจสถานะต้นทางก่อนเปลี่ยน; completion ยอมรับเฉพาะ `IN_PROGRESS`; kill switch ถูกตรวจใน transaction ก่อน claim งานใหม่

## Database and seed

- `db/schema.sql`: tables, constraints, indexes, system kill switch default-off
- `db/seed.sql`: bot 3 instances และ demo orders
- Metrics/logs/commands/deployments/audit มี timestamp เพื่อไล่เหตุการณ์ย้อนหลัง
- สำหรับ schema ที่มีอยู่แล้วใน database ให้รัน SQL ที่เพิ่ม/ปรับด้วย migration ที่ควบคุม version แทนการพึ่ง init scripts ของ Postgres

## Configuration

ดู `.env.example`. ค่า password ที่ให้เป็นเพียงค่า local demo; เปลี่ยนก่อนใช้งานจริง ห้าม commit `.env`. API demo นี้ยังไม่มี user authentication/authorization — `X-Actor` ใช้เพื่อแสดง audit actor เท่านั้น จึงต้องวาง auth, RBAC, rate limit, CSRF/CORS policy และ secret management ก่อนเปิดเครือข่ายจริง

## Production adaptation notes

- Agent ควร heartbeat เองพร้อม monotonic sequence/lease renewal; ปัจจุบันใช้ polling simulator เป็น heartbeat adapter
- Deployment endpoint เก็บ ZIP และ SHA-256 แล้วสร้าง deployment records แต่ simulator ไม่มีคำสั่ง update หรือ package transfer protocol; ตัวอย่างจึงใช้ restart เพื่อจำลอง rollout เท่านั้น ควรทำ signed manifest, authenticated download, checksum verify, staged rollout, health gate และ rollback ใน agent จริง
- ควรแยก dispatcher/timeout worker ออกจาก API process เมื่อ scale หลาย replicas, ใช้ advisory/row locks และ leader-safe scheduling, metrics/tracing, retention policy และ backup
- Kill switch ทำ best-effort remote stop; หาก bot ติดต่อไม่ได้ คำสั่งจะถูกบันทึกล้มเหลวและต้องให้ agent ตรวจ policy จาก control plane/lease ก่อนเริ่มงานใหม่

## Local development

```bash
npm install
npm run dev
```

ตั้ง `DATABASE_URL`, `SIMULATOR_URL=http://localhost:8788` และรัน PostgreSQL + simulator แยกต่างหากก่อนเริ่ม API. `npm run build` สร้าง JavaScript ลง `dist/`.
