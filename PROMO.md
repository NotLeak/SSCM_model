**正文（放在一条评论里，即首评）：**

```
Hi HN! I built SCLM, a local-first causal inference workbench with a hard rule: the LLM is a compiler, never a calculator.

You describe an event in plain language. The LLM compiles it into 2-3 quantitative structural causal models (variable types, exogenous noise, structural equations). Then a deterministic Monte Carlo runtime does ALL the math: backdoor adjustment, do-interventions, bootstrap CIs, and DoWhy-style refutation tests (placebo, half-sample, noise).

The narrator LLM then writes up the results — but every number it cites is cross-checked against the runtime's own list, and on mismatch it falls back to a template. So there is no code path where the model gets to invent a number.

It also always shows the naive observational estimate next to the backdoor-adjusted causal effect, so confounding bias becomes a number you can see.

Two files, zero npm dependencies, everything runs on localhost. Works with any OpenAI-compatible API (DeepSeek, GLM, Kimi, OpenAI), and the default "engine" format runs with no API key at all via a built-in demo model.

AGPL-3.0. Feedback very welcome — especially on the identification logic.
```

---

## 2. Reddit r/LocalLLaMA（英文）

**标题：**

```
I got tired of LLMs confidently inventing probabilities, so I built a runtime they're not allowed to do math in
```

**正文：**

```
The rule: the LLM can only output a *model spec* (variables, noise distributions, structural equations). A deterministic Monte Carlo runtime (1500 agents/arm, bootstrap CIs, backdoor adjustment computed at runtime, refutation tests) does every piece of arithmetic. The write-up LLM gets its numbers verified against the runtime's checklist and falls back to a template if it deviates.

- 2 files, 0 npm dependencies, runs on localhost
- Any OpenAI-compatible endpoint: local llama.cpp/ollama or DeepSeek/GLM/Kimi
- The default format works with NO key (built-in demo model, same runtime)
- AGPL-3.0

Repo: [你的仓库链接]

Happy to answer questions about the identification logic (backdoor criterion with descendant exclusion) — that part was the most fun to get right.
```

---

## 3. V2EX（分享创造节点，中文）

**标题：**

```
[分享创造] 写了个因果计算引擎：LLM 只准编译模型、禁止算数字，全部数值由本地蒙特卡洛运行时算出
```

**正文：**

```
起因是受不了让大模型"算一下概率"时它一本正经地编数字。

所以做了个硬约束的架构：LLM 只许把事件编译成定量 SCM（变量类型/噪声分布/结构方程），然后 server.js 里的确定性运行时做全部计算——后门准则识别调整集、do 干预蒙特卡洛（每臂 1500 智能体）、ATE + bootstrap 置信区间、安慰剂/半样本/加噪三类反驳检验。最后转述员 LLM 写报告时，引用的每个数字都要和运行时清单逐一比对，对不上就回退模板转述——全链路没有一条代码路径能让模型自己生成数字。

另外会把"观测天真估计"和"后门调整后因果效应"并排展示，混杂偏差直接数值化，相关≠因果这件事看得见。

两个文件、零 npm 依赖、纯本地运行；兼容任意 OpenAI 格式接口（DeepSeek/GLM/Kimi/OpenAI），默认格式没 Key 也能玩（内置演示模型，同一套运行时做真实计算）。

AGPL-3.0 开源：(https://github.com/NotLeak/SSCM_model.git)

欢迎拍砖，尤其是识别逻辑（后门准则 + 排除 exposure 后代）这块。
```

---

## 4. 知乎 / 少数派（文章角度）

**标题候选：**

- 《如何阻止大模型瞎编数字？我把它的"计算权"整个没收了》
- 《让 LLM 编译因果模型、代码跑蒙特卡洛：一个防幻觉架构的完整实现》

**结构大纲：**

1. 开头：贴一个"让 ChatGPT 算概率"翻车的真实例子（幻觉数字）
2. 核心：编译-执行分离——LLM 输出的每个字段如何被 Schema 约束，为什么"系数是领域判断的唯一出口"
3. 图解三层架构（README 里的 ASCII 图改成图）
4. 一个完整案例：混杂偏差数值化前后对比（用 preview.png）
5. 数字核验与模板回退的实现细节
6. 诚实局限：模拟推演、不可观测混杂定 C 级、无实证数据
7. 结尾放仓库链接

**即刻/朋友圈短文案：**

```
做了个"LLM 不准算数"的因果引擎：大模型只准编译模型结构，所有数字由本地蒙特卡洛运行时算出，转述时每个数字都要核对回溯。两个文件零依赖，AGPL 开源了👇 [链接]
```

---

## 5. GitHub 仓库设置（发布后 2 分钟做完）

- **About 栏简介**：`LLM compiles, code computes — a local causal engine that never lets the LLM output a number. 零依赖 · AGPL`
- **Website**：留空或以后填云托管版地址
- **Topics**：`causal-inference` `llm` `monte-carlo` `structural-causal-model` `backdoor-criterion` `anti-hallucination` `local-first` `zero-dependency`
- **开启**：Issues（用户反馈主渠道）；暂不开 Discussions（冷启动期没人聊，开着显冷清）
- **保护 main 分支**：等有第一个外部贡献者再说，现在不用
