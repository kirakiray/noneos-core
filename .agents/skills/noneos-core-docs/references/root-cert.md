# 根证书信任集与密钥轮换

NoneOS Core 发布完整性依赖两级签名：根证书信任集 `nos/root-cert.json` 是信任锚，`nos.json`（版本 + 文件哈希清单）必须由信任集中 **active** 状态的密钥签发。

## 信任集格式

```json
{
  "type": "root",
  "name": "noneos-root",
  "generation": 1,
  "signTime": 1748261520193,
  "publicKey": "<签名者公钥，必须属于 keys 中 active/grace 项>",
  "keys": [
    { "id": "root", "publicKey": "...", "status": "active" }
  ],
  "signature": "<由 publicKey 对应私钥签发>"
}
```

- `generation` 单调递增，客户端拒绝小于本地缓存值的证书（防回滚）。
- `keys[].status`：`active`（可签发 `nos.json` 与新信任集）、`grace`（过渡期，可签发信任集、不可签发 `nos.json`）、`retired`（不可签发任何内容）。

## 客户端校验规则

安装/更新时由 `nos-tool/_install/util.js` 的 `verifyRootCert` / `getOnlineData` 执行：

1. 结构校验 + `verifyData` 整体验签；
2. 签名者必须是信任集中 active/grace 的密钥；
3. 信任链二选一：
   - **全新安装**（无本地缓存）：签名者公钥 sha-256 指纹必须命中客户端内置的 `PINNED_ROOT_KEY_HASHES`；
   - **已有缓存**：签名者必须属于本地缓存的上一份受信信任集中的有效密钥（存于 `nos/storage` 的 `nos-root-trust` 空间）；
4. `nos.json` 验签通过，且其 `publicKey` 属于信任集 active 密钥。

## 密钥文件存放

- 根密钥：`rootkeys/root.json`（id 固定为 `root`，被 gitignore，**不入库**）
- 换根过渡期旧根密钥：`rootkeys/root-legacy.json`
- 轮换新增密钥：`rootkeys/keys/<id>.json`

## 轮换操作（scripts/rotate-root.js）

| 命令 | 作用 |
|------|------|
| `node scripts/rotate-root.js check` | 校验 `rootkeys/root.json` 公私钥配对并输出公钥指纹 |
| `node scripts/rotate-root.js init` | 初始化 generation 1 信任集（仅根密钥 active） |
| `node scripts/rotate-root.js add <id>` | 生成新密钥，以 grace 状态加入信任集（仍由旧钥签名，客户端平滑过渡） |
| `node scripts/rotate-root.js promote <id>` | 新钥转 active、原 active 转 retired，改由新钥签名 |
| `node scripts/rotate-root.js swap-root` | 手动换根（见下） |
| `node scripts/rotate-root.js retire <id>` | 将指定密钥移出信任集 |
| `node scripts/rotate-root.js revoke <id\|指纹>` | 吊销密钥（泄漏保底机制，见下） |
| `node scripts/rotate-root.js pin-hash [id]` | 输出密钥公钥的 sha-256 指纹 |

所有变更命令（init / add / promote / swap-root / retire）都会自动：重写客户端 `PINNED_ROOT_KEY_HASHES`（信任集中所有未退役密钥的指纹）→ 重算 `hashes.json` → 由 active 密钥重签 `nos.json`。

## 手动换根（swap-root）

适用于定期更换根密钥。操作步骤：

```bash
# 1. 旧根密钥保留一份（swap-root 需要旧私钥给过渡版信任集签名）
cp rootkeys/root.json rootkeys/root-legacy.json

# 2. 手动用新密钥对替换 rootkeys/root.json（{"public": ..., "private": ...} 格式）

# 3. 一条命令完成换根
node scripts/rotate-root.js swap-root
```

`swap-root` 会：校验新钥配对 → 生成 generation+1 的新信任集（新钥 active、旧钥转 grace 为 `root-legacy`，整体仍由旧钥签名）→ 自动更新 pin → 重签 `nos.json`。部署后：

- **已装机客户端**：本地缓存信任集中含旧钥，链式信任自动接受新证书，无需用户操作；
- **全新安装客户端**：pin 中同时含新旧指纹，签名者（旧钥）命中即可；
- 过渡期结束后执行 `node scripts/rotate-root.js retire root-legacy`，旧钥彻底退役、pin 移除旧指纹，再次部署即可。

## 泄漏保底机制：吊销（root-status.json）

`nos/root-status.json` 是独立于签名体系的**域名信任根**，其真实性由部署渠道（HTTPS + 域名控制权）保证，因此**不需要签名**：

```json
{
  "type": "root-status",
  "signTime": 1790000000000,
  "minGeneration": 2,
  "revokedKeyHashes": ["<被吊销公钥的 sha-256 指纹>"]
}
```

客户端更新时一并拉取（`cache: "no-store"`）：

- 证书 `generation` 低于 `minGeneration` → 拒绝；
- 信任集中任一密钥指纹命中 `revokedKeyHashes` → 拒绝；
- 拉取失败时降级使用 `nos/storage` 中缓存的最后一份；从未获取到则跳过检查。

**主私钥泄漏应急流程**（前提：部署渠道未被攻破）：

```bash
node scripts/rotate-root.js revoke root   # 吊销泄漏密钥，minGeneration 提到当前代之上
# 立即部署 nos/root-status.json
# 然后换新钥（swap-root 或 add+promote）重签信任集与 nos.json，恢复日常签发
```

吊销的效力来自域名控制权而非任何签名，因此不与攻击者进行 generation 竞赛：攻击者用泄漏钥签发的一切信任集，客户端一旦拉到新吊销状态即全部拒绝。注意该机制防不住「渠道与密钥同时失守」的场景。

## 泄漏保底机制之外：常规轮换（不换根密钥）

```bash
node scripts/rotate-root.js add k2       # 新钥 grace 加入
node scripts/rotate-root.js promote k2   # 新钥 active、旧钥 retired
```

> `npm run build:hashes` 内部执行 `scripts/calculate-nos-hashes.js` + `scripts/sign-hashes.js`；后者自动选取信任集中唯一的 active 密钥（对应密钥文件须存在）。

## 泄漏应急轮换

1. 提前在客户端 `PINNED_ROOT_KEY_HASHES` 中预埋备用密钥指纹（`pin-hash` 生成），随版本发布；
2. 泄漏发生后：生成/启用备用密钥 → `promote <备用密钥>`（旧钥自动 retired）→ 重签 `nos.json` 发布；
3. 已装机客户端依赖「generation 单调 + 缓存链式信任」拒绝攻击者的伪造旧证书；**新装机客户端**依赖内置 pin，因此若 pin 中所有密钥均泄漏，必须更新 `PINNED_ROOT_KEY_HASHES` 并发布新版客户端。
