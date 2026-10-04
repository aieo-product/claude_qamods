# claude_qamods

Claude Code mods built with the function-hooks plugin API. The first mod, **qa-guide**, adds a guide pane for Claude's `AskUserQuestion` prompts so you can make a decision with the context in view.

The pane shows:

- A status badge: awaiting an answer, answered, or cancelled.
- Your three most recent instructions from terminal, Remote Control, or SDK prompts, and Claude's explanation leading up to the question.
- Question cards with a header chip, a multi-select tag when applicable, numbered options, descriptions, and previews.
- A green ✔ beside each selected option after you answer.
- An optional AI explanation starting with a short summary of your current instructions and how the question relates, followed by why Claude is asking, each option's effects numbered in dialog order, and a numbered recommendation. Multiple questions have separate Q headings and restart option numbering at 1.
- Recent questions and answers, keeping up to 20 entries including the current question.

Answer through Claude Code's usual question interface. The guide updates alongside it, and AI explanation generation runs asynchronously so you can answer while it is still loading. The pane labels and AI explanations are currently in Japanese.

## Install

Run these commands inside Claude Code:

```text
/plugin marketplace add aieo-product/claude_qamods
/plugin install qa-guide@claude-qamods
```

Tested with **Claude Code 2.1.286**. The function-hooks API is early access and may change between releases.

## Usage

Use fullscreen mode and a wide terminal for the best experience. The pane opens automatically when Claude asks a question and the terminal is at least **144 columns** wide. If it cannot be placed, a toast points you to `/qa-guide`, which opens it explicitly at any width.

While a question is open, the pane shows only its background, sized to the visible rows without scrolling while the question dialog holds the keyboard. Question text, option cards, and previews stay in the question dialog. The AI explanation uses up to about 65% of the rows, with magenta headings, cyan option numbers, bold labels, and a green recommendation. Wrapped option text aligns after its number. Blank rows separate headings and context sections when space allows; text takes priority in short panes. The newest instruction uses up to two wrapped lines, and the latest lines of Claude's preceding explanation fill the remaining space. When AI is off or still loading, that space goes to the instruction and preceding explanation.

After you answer or cancel, the full view shows the selected question, its instructions, Markdown context, option cards, previews, and ✔ answers. Use `p` and `n` to browse questions one by one, or `l` to return to the latest; the toolbar shows your position, such as `3/7`. You can scroll to read the full content. The history list also has a button for each question, with the selected question marked.

| Control | Action |
| --- | --- |
| `/qa-guide` | Open the question guide, including before the first question. |
| `p` / ◀ 前 | View the previous (older) question. |
| `n` / 次 ▶ | View the next (newer) question. |
| `l` / 最新 | Return to the latest question. |
| `a` | Toggle AI explanations for subsequent questions. |
| `h` | Show or hide previous questions and answers. |
| Question button in history | Open that question in the full view. |
| Close button | Close the pane; `/qa-guide` opens it again. |

These keys work while the pane has keyboard focus in the full view. Click the pane or use `Ctrl+X`, then `Tab`, to move focus into it. Press `Esc` to return focus to the prompt. A new question always returns the guide to the latest entry.

AI explanations are enabled by default and add a model call for each question. `$.model.fork` uses the session's model and transcript, reusing its prompt cache when available; calls still incur usage costs, and an expired cache or model change can increase input costs. Toggle AI off with `a` to prevent forks for subsequent questions. This does not cancel an explanation already in progress. Preferences and question history last only for the current session.

## Local development

From a checkout of this repository:

```sh
claude --plugin-dir plugins/qa-guide
```

Validation and tests:

```sh
claude plugin test plugins/qa-guide
npx -y -p typescript@5 tsc -p plugins/qa-guide --noEmit
claude plugin validate plugins/qa-guide
```

Type checking requires the engine-generated, gitignored types in `plugins/qa-guide/.claude-plugin/types/`. Claude Code writes these files when it loads the local plugin. Start a new local development session after upgrading Claude Code to refresh them.

## 日本語

**qa-guide** は、Claude の質問の背景・選択肢・回答履歴をペインに表示します。質問中のコンパクト表示は背景説明だけに絞り、質問文・選択肢・プレビューは質問ダイアログで確認します。AI 解説は表示行数の約65%まで、最新の指示は折り返して2行まで表示し、残りに直前の Claude の説明の末尾を表示します。AI 解説の選択肢はダイアログと同じ順序・番号で、番号をシアン、ラベルを太字、おすすめを緑の太字で表示します。複数の質問は Q 見出しで分け、質問ごとに1から番号を振ります。折り返しは番号の後に揃え、余裕があるときは見出しの前に空行を入れます。行数が少ないときは本文を優先します。AI がオフ・生成中の場合は指示と直前の説明に行数を回し、スクロールなしで読める範囲に収めます。

回答・キャンセル後の全文表示では、選択中の質問の指示・背景・選択肢・✔回答を確認できます。`/qa-guide` で開き、ペインにフォーカスした状態で `p`（◀ 前）で古い質問、`n`（次 ▶）で新しい質問、`l`（最新）で最新の質問へ移動します。ツールバーには `3/7` のような位置が表示されます。`h` で履歴を開くと、各質問のボタンから直接移動でき、選択中の質問に印が付きます。新しい質問が来ると最新に戻ります。`a` は AI 解説の切り替え、閉じるボタンはペインを閉じます。AI 解説には追加のモデル利用料金がかかります。全画面・幅広のターミナルを推奨します。

## License

[MIT](LICENSE).
