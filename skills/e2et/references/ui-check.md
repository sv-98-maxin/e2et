# 断言与 UI 诊断

先查 `e2et commands assert --json` 及所需 page/capture 定义；结果判读见 [acceptance.md](acceptance.md)。预期来自用户或已核实的场景，不从当前页面值反推“应该是什么”。

## 选对应证据

| 需要核对 | 命令 |
|---|---|
| 可见文本、字段、表格行 | assert text / field / table-row |
| 展示、提示、URL | assert visible / absent / toast / url |
| localStorage / 全局标量 | page read 观察；assert data 正式核值 |
| CSS 计算样式 | assert style |
| DOM 属性、数量、几何、图片与溢出 | assert element |
| Console 条件 | page console 观察；assert console 正式核值 |
| 请求体/query、响应/安全响应头 | assert request / api，见 acceptance |
| UI 异常候选 | page inspect，候选本身不是断言 |
| 视觉完成态 | page screenshot --group，截图本身不是断言 |

```bash
e2et assert text -s '<sid>' '<预期文本>' --within '<target>' --group '<group>'
e2et assert field -s '<sid>' '<字段标签>' '<预期值>' --group '<group>'
e2et assert visible -s '<sid>' '<target>' --group '<group>'
e2et assert url -s '<sid>' '<URL片段>' --group '<group>'
e2et assert data -s '<sid>' --local-storage '<key>' --path '<dot-path>' --equals '<value>' --group '<group>'
```

## 样式与元素

```bash
e2et assert style -s '<sid>' '<target>' --property '<css>' --equals '<计算值>' --group '<group>'
e2et assert style -s '<sid>' '<target>' --property '<css>' --equals '<计算值>' --pseudo before --all --group '<group>'
e2et assert element -s '<sid>' '<target>' --property count --expect '== 0' --group '<group>'
```

- style 默认要求唯一目标；all 核全部匹配。伪元素用 pseudo before/after，不能以宿主样式代替。
- CSS 规则文本不是计算样式。style 零匹配不通过；element count 允许 0，text/rect/scroll/client/image/overflowX 等属性零匹配不通过。
- 布局预期用对应计算值/几何断言与截图说明；不能仅凭“看起来变了”判定。

## Console 与 UI 诊断

```bash
e2et page console -s '<sid>'
e2et assert console -s '<sid>' --no-error --group '<group>'
e2et assert console -s '<sid>' --level error --contains '<文本>' --count '<n>' --group '<group>'
e2et page inspect -s '<sid>' --check overflow --within '<target>' --group '<group>'
```

- console 默认 scope session；仅检查某次动作时显式 scope action。console.assert 失败计 error。
- 未订阅、日志截断或 frame 归属/完整性不明时，不以 no-error 宣称无错误；warning 保留事实，可说明噪音但不删证据。
- inspect 支持 text-artifacts / i18n / overflow / broken-images / error-exposure。within 须唯一；可加 frame。它返回诊断候选，不产生业务 PASS；与本次预期有关时用正式 assert 确认，证据不足就说明未查清。

## iframe 与交互

- frame 内动作、文本/字段/可见/样式/元素/console 检查显式带 `--frame '<name|url_contains|selector>'`；先 page state --frame，再用显式 target，不用主文档索引替代。
- click/hover/type 后核用户要求的可观察结果。菜单打开不能证明选择成功，接口成功不能证明渲染成功。
- 按钮无响应时检查 state、请求与 console；页面含 frame 时查对应 frame。没有证据就说明未查清，不猜“前端/后端 bug”。
- 需要 blur 校验时用 type/press Tab 等实际交互。等待依附触发动作，写操作不为修断言重复执行。
- 完成态截图放在本 group 全部动作、断言和其他证据之后；命令与 plan 规则集中在 acceptance。
