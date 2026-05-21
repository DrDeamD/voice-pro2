# Deployment Guide — Trading Court Pro v3.2

## Problem solved
The previous setup used `wrangler pages dev` which caused:
```
SENTRY_DO SQLite failed; NOSENTRY database is locked: SQLITE_BUSY
Workers runtime failed to start
```
**Fix:** Replaced Cloudflare Workerd with a native Node.js server using `@hono/node-server`.
No more Wrangler, no SQLite, no Workerd crashes.

---

## Quick Deploy (Contabo / any VPS)

```bash
# 1. Upload and extract
cd /root
unzip trading-court-pro-v3.2.zip
cd trading-court-pro

# 2. Install dependencies
npm install

# 3. Build (TypeScript → JavaScript)
npm run build

# 4. Test it works
node dist/server.js
# Should print:
# ✅ Server running at http://0.0.0.0:3000
# ✅ Snapshot ready: 8 pairs, XX calendar events

# 5. Run with PM2 (stays running after logout)
npm install -g pm2
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # run the command it outputs

# 6. Verify
curl http://localhost:3000/healthz
curl 'http://localhost:3000/api/snapshot?force=1' | python3 -m json.tool | head -30
```

---

## Port / Nginx

Default port: **3000**. To change:
```bash
PORT=8080 node dist/server.js
# OR in ecosystem.config.cjs: env: { PORT: 8080 }
```

Nginx reverse proxy (optional, for port 80):
```nginx
server {
    listen 80;
    server_name your-ip-or-domain;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## PM2 Commands
```bash
pm2 status                    # check running
pm2 logs trading-court-pro    # live logs
pm2 restart trading-court-pro # restart
pm2 stop trading-court-pro    # stop
```

---

## Data Sources Test
After deployment, verify all data sources work:
```bash
# Kraken candles
curl "https://api.kraken.com/0/public/OHLC?pair=EURUSD&interval=5" | python3 -c "import json,sys;d=json.load(sys.stdin);print('Kraken OK:',len(list(d['result'].values())[0]),'M5 bars')"

# Investing.com candles (new)
curl "https://api.investing.com/api/financialdata/1/historical/chart?period=P1D&interval=PT5M&pointscount=60" -H "domain-id: www" | python3 -c "import json,sys;d=json.load(sys.stdin);print('Investing OK:',len(d['data']),'bars')"

# Calendar
curl "http://localhost:3000/api/calendar?hours=24" | python3 -c "import json,sys;d=json.load(sys.stdin);print('Calendar:',d['count'],'events')"

# Full snapshot
curl "http://localhost:3000/api/snapshot?force=1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('Pairs:', len(d['pairs']))
print('Calendar:', len(d['calendarEvents']), 'events')
for src,info in d['dataSourceHealth'].items():
    print(f'  {\"OK\" if info[\"ok\"] else \"FAIL\"}  {src}')
"
```
