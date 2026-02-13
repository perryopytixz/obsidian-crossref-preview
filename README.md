# Obsidian-Crossref-Preview

一个 **仅作用于预览层（preview-only）** 的 Obsidian 社区插件。
在不改动 Markdown 源文件的前提下，为 Quarto 风格交叉引用提供实时预览支持。

核心目标：
在 Obsidian 中进行所见即所得的 Quarto 文档写作，支持公式、图片、定理等对象的自动编号、引用、点击跳转，并兼容编辑与阅读工作流。

## 功能（MVP）

- 当前文件内公式编号与引用：`{#eq-foo}` + `@eq-foo`
- 当前文件内图片编号与引用：`{#fig-foo}` + `@fig-foo`
- 当前文件内定理类块编号与引用：`{#thm-...}`、`{#lem-...}` 等 + `@thm-...`、`@lem-...`
- 引用可点击跳转到目标锚点
- 缺失引用保持原样并附带缺失样式类（便于排查）

## 设计原则

- 不写回 vault，不修改磁盘上的 Markdown
- 不注入 `\tag{}` 到公式源码
- Quarto/Pandoc 仍然是导出时的权威编译器
- 公式语法遵循 Obsidian 原生支持：行内 `$...$`、行间 `$$...$$`

## 支持的标签前缀

- 公式：`eq-`
- 图片：`fig-`
- 定理类：
  - `thm-`, `lem-`, `cor-`, `prp-`, `cnj-`
  - `def-`, `exm-`, `exr-`, `sol-`, `rem-`, `alg-`

## 目录结构

- `main.js`：插件主逻辑（解析、编号、渲染、引用替换、锚点跳转）
- `manifest.json`：Obsidian 插件清单
- `styles.css`：插件样式
- `versions.json`：版本兼容映射
- `docs/技术设计文档.md`：中文技术设计文档

## 安装到 Obsidian

假设你的 vault 路径为 `/path/to/your-vault`：

1. 创建插件目录：

```bash
mkdir -p /path/to/your-vault/.obsidian/plugins/obsidian-crossref-preview
```

2. 将以下文件复制到该目录：

- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`

3. 打开 Obsidian：

- `设置` -> `第三方插件`
- 关闭安全模式（若尚未关闭）
- 启用 `Obsidian Crossref Preview`

## 验收样例（综合长样例）

说明：以下样例只使用 Obsidian 原生数学语法（行内 `$...$`、行间 `$$...$$`）。

````markdown
# Crossref Preview 综合测试

这是一份用于测试交叉引用的长样例文档。请在 Live Preview 和阅读模式各检查一次。

---

## 1) 公式区（3 个公式 + 多次引用）

先给一个行内公式示例：$a^2+b^2=c^2$（行内公式仅做渲染展示，不参与编号）。

$$
E = mc^2
$$
{#eq-energy}

$$
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}
$$
{#eq-gauss}

$$
f(x) \approx f(a) + f'(a)(x-a) + \frac{f''(a)}{2}(x-a)^2
$$
{#eq-taylor2}

同段引用测试：由 @eq-energy 可见质量与能量关系；结合 @eq-gauss 可得到电场散度与电荷密度关系；而 @eq-taylor2 常用于局部近似。

长段压力测试：在一段较长中文中反复引用 @eq-energy、@eq-taylor2、@eq-gauss，检查引用替换是否稳定，是否出现错位或重复嵌套。

---

## 2) 图片区（2 张图 + 交叉引用）

![Figure One](https://picsum.photos/seed/crossref-1/960/360){#fig-one}
![Figure Two](https://picsum.photos/seed/crossref-2/960/360){#fig-two}

图片引用测试：先看 @fig-one，再看 @fig-two；重复引用 @fig-one，编号应保持一致。

---

## 3) 定理区（Definition + Lemma + Theorem + Algorithm）

::: {#def-inner-product}
## Inner Product
设 $V$ 是实向量空间，映射 $\langle\cdot,\cdot\rangle:V\times V\to\mathbb{R}$ 满足线性、对称、正定，则称为内积。
:::

::: {#lem-cs}
## Cauchy-Schwarz
对任意 $u,v\in V$，有
$$
|\langle u,v\rangle| \le \|u\| \cdot \|v\|
$$
:::

::: {#thm-projection}
## Orthogonal Projection
设 $W \subseteq V$ 为子空间，则任意 $x \in V$ 可唯一分解为
$$
x = w + z,\quad w\in W,\ z\in W^\perp
$$
:::

::: {#alg-gaussian}
## Gaussian Elimination
1. 选主元
2. 交换行
3. 向下消元
4. 回代求解
:::

定理引用测试：基础定义见 @def-inner-product，引理见 @lem-cs，核心结论见 @thm-projection，计算流程见 @alg-gaussian。

---

## 4) 混合引用长段落

在这段较长文本中同时引用不同对象：先根据 @thm-projection 说明分解结构，再使用 @eq-taylor2 说明局部近似，接着参考 @fig-two 做图示解释，最后回到 @alg-gaussian 讨论实现步骤。检查整段替换与跳转是否稳定。

---

## 5) 缺失引用测试（应显示缺失样式）

故意不存在的引用：@eq-not-found、@fig-missing、@thm-ghost。

---

## 6) 不应替换区域

行内代码 `@eq-energy` 不应被替换。

```python
# 代码块中的 @eq-energy / @thm-projection 不应被替换
def demo():
    return "@eq-energy should stay raw in code"
```
````

预期验收：

- 公式编号连续显示为 `(1)(2)(3)`，并且引用替换正确
- 图片显示 `Figure 1/2`，引用可点击跳转
- 定理类显示类型编号（Definition/Lemma/Theorem/Algorithm）
- 点击引用可跳转并高亮目标
- 缺失引用保留原文本语义并显示缺失样式

## 技术文档

- 请参考：`docs/技术设计文档.md`

## License

MIT
