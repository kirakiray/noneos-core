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
- 轮换新增密钥：`rootkeys/keys/<id>.json`

## 轮换操作（scripts/rotate-root.js）

| 命令 | 作用 |
|------|------|
| `node scripts/rotate-root.js init` | 初始化 generation 1 信任集（仅根密钥 active） |
| `node scripts/rotate-root.js add <id>` | 生成新密钥，以 grace 状态加入信任集（仍由旧钥签名，客户端平滑过渡） |
| `node scripts/rotate-root.js promote <id>` | 新钥转 active、原 active 转 retired，改由新钥签名 |
| `node scripts/rotate-root.js retire <id>` | 将指定密钥移出信任集（应急移除泄漏密钥） |
| `node scripts/rotate-root.js pin-hash [id]` | 输出密钥公钥的 sha-256 指纹，用于写入客户端 `PINNED_ROOT_KEY_HASHES` |

常规轮换流程：

```bash
node scripts/rotate-root.js add k2       # 新钥 grace 加入
node scripts/rotate-root.js promote k2   # 新钥 active、旧钥 retired
npm run build:hashes                     # 重算 hashes 并由 active 密钥签发 nos.json
```

> `npm run build:hashes` 内部执行 `scripts/calculate-nos-hashes.js` + `scripts/sign-hashes.js`；后者自动选取信任集中唯一的 active 密钥（对应密钥文件须存在）。

## 泄漏应急轮换

1. 提前在客户端 `PINNED_ROOT_KEY_HASHES` 中预埋备用密钥指纹（`pin-hash` 生成），随版本发布；
2. 泄漏发生后：生成/启用备用密钥 → `promote <备用密钥>`（旧钥自动 retired）→ 重签 `nos.json` 发布；
3. 已装机客户端依赖「generation 单调 + 缓存链式信任」拒绝攻击者的伪造旧证书；**新装机客户端**依赖内置 pin，因此若 pin 中所有密钥均泄漏，必须更新 `PINNED_ROOT_KEY_HASHES` 并发布新版客户端。
