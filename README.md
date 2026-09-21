# 古船模型吊装转运与复位放行台

运行：

```bash
npm start
```

- 转运台页面：`http://localhost:3038/`
- 判定记录：`http://localhost:3038/decisions`
- 归档：`http://localhost:3038/archive`

数据分开承载，刷新后状态一致：

- `data/transfer-active.json`：在途模型与开放转运单
- `data/transfer-decisions.json`：登记/复位/复校/改单/放行/交付/作废的判定留痕
- `data/transfer-archive.json`：已交付、已作废转运单（含历史版本）

规则：

- 一个模型只能有一张开放转运单
- 封帆或拆桅前须登记 ≥2 个支撑位、锁具号、责任人及原索径/绕向/张力；支撑不足或锁具被他单占用时整单拒绝且不落库
- 复位按原索径、绕向、张力校验，不符只进待复校；复校人须与拆装人不同，并自动留存比对前值
- 改动转运单即作废复位与交付资格，旧版本留档可追溯
