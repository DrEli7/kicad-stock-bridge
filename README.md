# KiCad Stock Bridge

把 **KiCad 已导出的 BOM** 与 **本地库存 CSV** 接起来：算一批板子缺多少料，输出可检查的采购差额。离线、只读、不连接供应商、不扣减库存。

**English:** A small, read-only bridge from existing KiCad BOM CSV files to local inventory shortage plans. Exact part IDs, build multipliers, spare quantities, DNP handling, explicit diagnostics, and spreadsheet-safe CSV output.

## 为什么存在

KiCad 已有 BOM 导出；[KiBOM](https://github.com/SchrodingersGat/KiBoM)、[KiCost](https://github.com/xesscorp/KiCost)、[jBOM](https://github.com/plocher/jBOM) 分别覆盖 BOM、价格与库存相关工作。本项目不是另一套 EDA/BOM 引擎，也不声称是唯一库存工具。它面向这个小场景：**已有 BOM，手边库存是一张表，只想算下一批板子的缺口，不部署库存服务或接供应商 API。**

CSV 由成熟的 [`csv-parse`](https://csv.js.org/parse/) / [`csv-stringify`](https://csv.js.org/stringify/) 处理，包含引号、BOM、多行字段与 TSV；业务逻辑只做本地差额规划。

## 安装与 30 秒示例

需要 Node.js 22 或更新版本。当前从 GitHub 使用，未声明已发布到 npm。

```sh
git clone https://github.com/DrEli7/kicad-stock-bridge.git
cd kicad-stock-bridge
npm ci --ignore-scripts
npm test
npm run demo
```

示例使用合成 BOM：每板 3 颗 `RES-10K-0603`、1 颗 `REG-DEMO-33`，本地分别有 7、2 颗。做 3 块板，并为每个独立料号留 1 颗备料，结果是：

| 料号 | 所需 | 库存 | 缺口 |
| --- | ---: | ---: | ---: |
| REG-DEMO-33 | 4 | 2 | 2 |
| RES-10K-0603 | 10 | 7 | 3 |

## 对接 KiCad

在 KiCad 符号字段里为每种物料填写唯一的 `MPN` 或自有 `SKU`。推荐将字段导出为 `MPN,Quantity,Reference,DNP`；其他列允许存在。

[KiCad 官方 CLI](https://docs.kicad.org/9.0/en/cli/cli.html#schematic-bill-of-materials-export) 支持选择字段、标签和分组。PowerShell 与 Bash 都可使用以下单引号保护 `${QUANTITY}` 不被 shell 展开：

```sh
kicad-cli sch export bom --fields 'Reference,Value,Footprint,MPN,${QUANTITY},${DNP}' --labels 'Reference,Value,Footprint,MPN,Quantity,DNP' --group-by 'MPN,Value,Footprint' --output bom.csv board.kicad_sch
```

也可从 KiCad 符号字段表导出 CSV。请检查实际标题；不同预设可能使用 `Qty` 而非 `Quantity`，可映射，无需修改文件。

库存文件最小格式：

```csv
MPN,Stock
RES-10K-0603,7
REG-DEMO-33,2
```

## 使用

```sh
# 默认 Markdown 报告
node src/cli.mjs --bom bom.csv --stock stock.csv --boards 10 --spares 2

# 可供程序使用的完整报告
node src/cli.mjs --bom bom.csv --stock stock.csv --format json

# 仅缺料行，输出到新文件（不要覆盖输入）
node src/cli.mjs --bom bom.csv --stock stock.csv --boards 10 --format csv > shortages.csv

# 自定义标题；BOM 与库存的标识符列可以不同
node src/cli.mjs --bom bom.csv --stock stock.csv --bom-key SKU --stock-key Part --quantity-column Qty --stock-column Available

# TSV；可在流水线中通过退出码检查
node src/cli.mjs --bom bom.tsv --stock stock.tsv --delimiter tab --check
```

`--spares` 是**每个独立料号的额外颗数**，不是百分比，也不再乘板数。公式：`required = sum(BOM quantity) × boards + spares`；`shortage = max(required − available, 0)`。料号去掉首尾空白后按大小写精确匹配，不根据阻值、封装或模糊名称猜测替代料。

默认列：`MPN` / `MPN`、`Quantity`、`Stock`；可选 `Reference`、`DNP`。`--reference-column` 与 `--dnp-column` 可更改可选列名。DNP 的 `1,true,yes,y,DNP,x` 会排除，空白/`0,false,no,n` 表示参与；未知标记作为错误报告。

| 退出码 | 含义 |
| --- | --- |
| 0 | 生成了可用计划；默认允许存在缺口 |
| 1 | 使用 `--check` 且存在缺口 |
| 2 | 参数、CSV 或业务数据有错误，计划不完整 |

JSON/Markdown 会保留错误诊断；有错误时**拒绝输出采购 CSV**。缺失库存条目按 0 规划并明确警告；重复库存料号必须先合并，否则拒绝猜测。重复参考标号 token 会报错，参考标号区间（如 `R1-R5`）不展开，无法检测不同区间的重叠。CSV 的危险公式前缀使用成熟输出库加单引号转义；JSON 保留原始料号。

## 库接口

```js
import { planStock, formatShortageCsv } from './src/index.mjs';
const result = planStock(bomText, stockText, { boards: 10, spares: 2 });
if (result.complete) console.log(formatShortageCsv(result));
```

## 边界与测试

- 数量为非负安全整数；BOM 每行至少 1，板数至少 1。库存按快照使用，不代表预留成功。
- 不解析 `.kicad_sch`，不查询价格，不算采购 MOQ/包装倍率，不推断替代料，不自动下单。
- 单节表格 CSV。旧版多节 legacy BOM 需先用 KiCad 导出单节 CSV。错误中的行号是 CSV 记录序号，带换行字段时不等于文件物理行号。
- `examples/` 全是合成测试数据，没有真实采购信息。库存只在内存中计算，工具不写入输入。
- `npm test` 覆盖聚合、多板/备料、DNP、重复库存/标号、缺字段、无效数量、溢出、CSV quoting、公式转义和 CLI 退出码。CI 在 Ubuntu / Windows 与 Node 22 / 24 运行。

MIT License。与 KiCad 及上述项目无官方关联。
