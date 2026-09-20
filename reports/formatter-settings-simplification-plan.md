# Formatter 设置精简实施计划

## 目标

将当前按语言重复定义的 12 个 formatter 设置精简为 4 个公开设置，同时保留 DECORATE、ACS 和 SBARINFO 的按语言覆盖能力。

本次调整只改变 formatter 的配置入口，不改变默认格式化结果：没有自定义设置的用户在升级前后应得到完全相同的输出。

## 当前问题

`package.json` 当前分别为 DECORATE、ACS 和 SBARINFO 定义格式设置：

- DECORATE：6 项
- ACS：5 项
- SBARINFO：1 项

其中 `braceStyle` 在三种语言中重复，`spaceAfterComma`、`spaceInEmptyBraces` 和 `removeBlankLinesBeforeCloseBrace` 在 DECORATE 与 ACS 中重复。三个 formatter 还分别多次调用 `workspace.getConfiguration()`，配置读取逻辑较分散。

当前设置默认未声明 `scope`，因此使用 VS Code 的默认 `window` scope；这不适合需要通过 `[decorate]`、`[acs]` 或 `[sbarinfo]` 分别覆盖的 formatter 风格设置。

## 最终公开设置

保留以下 4 项：

```jsonc
"zandronum-vscode.format.braceStyle": {
  "type": "string",
  "enum": ["nextLine", "sameLine"],
  "enumItemLabels": ["Next line (Allman)", "Same line"],
  "default": "nextLine",
  "scope": "language-overridable",
  "markdownDescription": "Controls brace placement for DECORATE, ACS, and SBARINFO."
},
"zandronum-vscode.format.spaceAfterComma": {
  "type": "boolean",
  "default": true,
  "scope": "language-overridable",
  "description": "Insert one space after commas in DECORATE and ACS."
},
"zandronum-vscode.decorate.format.stateLabelIndent": {
  "type": "integer",
  "default": 0,
  "minimum": 0,
  "scope": "language-overridable",
  "description": "Extra indentation for DECORATE state labels."
},
"zandronum-vscode.decorate.format.stateFrameIndent": {
  "type": ["integer", "null"],
  "default": null,
  "minimum": 0,
  "scope": "language-overridable",
  "description": "Extra indentation for DECORATE state frames. null uses the editor tab size."
}
```

`stateLabelIndent` 和 `stateFrameIndent` 仍放在 DECORATE 命名空间，因为它们表达 DECORATE `States` 块的专属语义，不应伪装成通用格式选项。

## 固定为 formatter 规范的行为

删除以下公开设置，将其当前默认值固定在 formatter 中：

- `spaceInEmptyBraces = false`：空块统一使用 `{}`。
- `spaceAfterControlKeyword = true`：ACS 控制关键字统一使用 `if (x)` 一类写法。
- `removeBlankLinesBeforeCloseBrace = true`：统一移除紧邻闭合 `}` 之前的空行。

这些规则属于稳定的格式化输出规范，而不是高价值的项目风格选择。固定后可减少设置噪音，也能降低 formatter 行为组合数和测试负担。

## 设置迁移映射

### 合并

- `zandronum-vscode.decorate.format.braceStyle`
- `zandronum-vscode.acs.format.braceStyle`
- `zandronum-vscode.sbarinfo.format.braceStyle`

合并为：

- `zandronum-vscode.format.braceStyle`

DECORATE 与 ACS 的：

- `*.format.spaceAfterComma`

合并为：

- `zandronum-vscode.format.spaceAfterComma`

### 删除

- `zandronum-vscode.decorate.format.spaceInEmptyBraces`
- `zandronum-vscode.decorate.format.removeBlankLinesBeforeCloseBrace`
- `zandronum-vscode.acs.format.spaceInEmptyBraces`
- `zandronum-vscode.acs.format.spaceAfterControlKeyword`
- `zandronum-vscode.acs.format.removeBlankLinesBeforeCloseBrace`

### 保留

- `zandronum-vscode.decorate.format.stateLabelIndent`
- `zandronum-vscode.decorate.format.stateFrameIndent`

## 用户配置方式

通用默认值：

```jsonc
"zandronum-vscode.format.braceStyle": "nextLine",
"zandronum-vscode.format.spaceAfterComma": true
```

按语言覆盖：

```jsonc
"[acs]": {
  "zandronum-vscode.format.braceStyle": "sameLine"
},
"[decorate]": {
  "zandronum-vscode.format.spaceAfterComma": false,
  "zandronum-vscode.decorate.format.stateLabelIndent": 1
}
```

## 实施步骤

### 1. 重组 Settings UI

修改 `package.json`：

1. 将 `contributes.configuration` 从单个对象改为两个分类。
2. 保留 `Zandronum` 分类用于编译、构建、资源与编辑器功能设置。
3. 新增 `Zandronum › Formatting` 分类，只放上述 4 个公开设置。
4. 为分类及设置添加显式 `order`，避免依赖字典序。
5. 将 formatter 设置声明为 `language-overridable`。
6. 移除被合并或固定的旧设置声明。

不要将所有规则放入一个 object 类型设置。嵌套复杂 object 往往无法在 VS Code Settings UI 中逐项编辑，只能跳转 `settings.json`，会牺牲可发现性和输入校验。

### 2. 统一读取通用配置

增加一个轻量共享模块，例如：

```text
src/language/formatConfiguration.ts
```

职责限定为：

- 定义共享 `BraceStyle` 类型。
- 为给定 `TextDocument` 读取 `format.braceStyle`。
- 为给定 `TextDocument` 读取 `format.spaceAfterComma`。
- 对无效值进行安全回退。

读取配置时使用 `document` 作为 configuration scope：

```ts
const configuration = vscode.workspace.getConfiguration(
    'zandronum-vscode',
    document
);
```

不要只传 `document.uri`。共享设置依赖文档语言 ID 来解析 `[acs]`、`[decorate]` 和 `[sbarinfo]` 覆盖。

每个 formatter 的一次 `toFormatOptions()` 调用最多取得一次 configuration 对象，避免为每个字段重复调用 `getConfiguration()`。

### 3. 更新 DECORATE formatter

修改 `src/language/decorate/formattingProvider.ts`：

- 从共享模块读取 `braceStyle` 和 `spaceAfterComma`。
- 继续读取两个 DECORATE 专属缩进设置。
- 将 `spaceInEmptyBraces` 固定为 `false`。
- 将 `removeBlankLinesBeforeCloseBrace` 固定为 `true`。
- 保留 `FormattingOptions.tabSize` 和 `FormattingOptions.insertSpaces`，不创建对应扩展设置。
- 删除被共享模块替代的本地读取函数。

### 4. 更新 ACS formatter

修改 `src/language/acs/formattingProvider.ts`：

- 从共享模块读取 `braceStyle` 和 `spaceAfterComma`。
- 将 `spaceInEmptyBraces` 固定为 `false`。
- 将 `spaceAfterControlKeyword` 固定为 `true`。
- 将 `removeBlankLinesBeforeCloseBrace` 固定为 `true`。
- 保留 VS Code 提供的 `tabSize` 和 `insertSpaces`。
- 删除旧的逐项设置读取函数。

### 5. 更新 SBARINFO formatter

修改 `src/language/sbarinfo/formattingProvider.ts`：

- 改为读取共享的 `format.braceStyle`。
- 删除 `sbarinfo.format.braceStyle` 的本地读取函数。
- 不增加 SBARINFO 尚未实现的逗号或空块格式能力。

共享配置存在不表示每个 formatter 必须实现全部选项；`spaceAfterComma` 当前只供 DECORATE 和 ACS 使用。

### 6. 配置兼容与发布说明

本计划采用直接迁移，不在 Settings UI 中继续贡献旧键。原因是继续声明 deprecated 设置仍会造成设置页拥挤，无法实现本次精简目标。

发布说明应明确列出旧键与新键映射，并给出 `[language]` 覆盖示例。旧的用户设置不会自动改写；使用旧键的用户需要手动迁移。

如果项目在正式发布前确认已有大量外部用户，可追加一次性迁移命令或启动提示，但不应长期保留两套设置读取逻辑。除非有实际兼容需求，不为此引入配置迁移框架。

## 受影响文件

预计修改：

- `package.json`
- `src/language/decorate/formattingProvider.ts`
- `src/language/acs/formattingProvider.ts`
- `src/language/sbarinfo/formattingProvider.ts`
- `src/test/decorateFormat.test.ts`
- `src/test/acsFormat.test.ts`
- SBARINFO formatter 对应测试文件

预计新增：

- `src/language/formatConfiguration.ts`
- `src/test/formatConfiguration.test.ts`，如果现有 VS Code 测试环境适合独立测试配置解析

若共享模块无法在不增加 mock 复杂度的情况下独立测试，应通过三个 provider 的集成测试覆盖，避免为了测试而引入额外抽象。

## 测试计划

### 默认行为回归

确认未配置任何 formatter 设置时：

- 三种语言仍使用 `nextLine`。
- DECORATE 与 ACS 仍在逗号后插入空格。
- 空块仍保持 `{}`。
- ACS 控制关键字仍使用 `if (x)`。
- 闭合大括号前多余空行仍被移除。
- DECORATE state label/frame 默认缩进不变。

现有针对被删除选项的参数级 formatter 单元测试应保留。删除的是用户配置入口，不是内部 `FormatOptions` 测试能力；这些测试仍可验证底层格式函数在显式参数下的行为，除非后续决定同步删除相应内部选项。

### 通用设置

增加测试确认：

- `format.braceStyle = sameLine` 同时作用于 DECORATE、ACS、SBARINFO。
- `format.spaceAfterComma = false` 作用于 DECORATE 和 ACS。
- 非法的 brace style 安全回退为 `nextLine`。

### 语言级覆盖

在扩展测试环境中配置：

```jsonc
"zandronum-vscode.format.braceStyle": "nextLine",
"[acs]": {
  "zandronum-vscode.format.braceStyle": "sameLine"
}
```

验证：

- ACS 使用 `sameLine`。
- DECORATE 和 SBARINFO 继续使用 `nextLine`。

这是本次变更最重要的新能力，必须有自动化覆盖；只测试全局设置不足以证明 `language-overridable` 与 configuration scope 使用正确。

### Manifest 校验

确认：

- `package.json` 只有 4 个 formatter 设置。
- 所有 formatter 设置均出现在 Formatting 分类。
- enum、默认值、scope 和描述正确。
- 不存在旧 formatter 设置键。

## 验证命令

```bash
npm run compile
npm run lint
npm test
```

如果 `npm test` 包含完整 VS Code Electron 测试且耗时较长，可先运行项目已有的定向 formatter 测试入口，再运行完整测试作为最终验收。

## 验收标准

- formatter 公开设置从 12 项减少到 4 项。
- Settings UI 将 formatter 设置与编译、构建和资源设置分组展示。
- 默认格式化输出与变更前一致。
- 用户可以通过 `[decorate]`、`[acs]`、`[sbarinfo]` 对通用 formatter 设置进行语言级覆盖。
- 三个 provider 不再分别维护重复的 brace style 配置读取逻辑。
- `tabSize` 和 `insertSpaces` 继续遵循 VS Code 标准 `FormattingOptions`。
- 编译、lint 和完整测试全部通过。

## 非目标

本次不做以下工作：

- 不重写 formatter 核心算法。
- 不新增 formatter preset 系统。
- 不引入项目级 `.zandronum-format` 配置文件。
- 不更改 DECORATE、ACS 或 SBARINFO 的默认格式风格。
- 不为尚未实现的格式能力预先增加设置。
- 不调整与 formatter 无关的 ACC、PK3、PLAYPAL 或 texture editor 设置。

