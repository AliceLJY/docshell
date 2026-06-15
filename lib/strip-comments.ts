/**
 * 流式 HTML 注释剥离器。
 *
 * 为什么需要：某些 MCP server 会让模型在每轮回复末尾追加 `<!-- ... -->` 形式的状态注释。这类注释
 * 会漏进"文档正文"、破坏文档观感。这里在文本流进文档前机械地剥掉所有 HTML 注释（不依赖模型自觉，
 * 是确定性保证）。
 *
 * 难点：注释可能跨多个 stream delta（`<!--` 在一个 delta、`... -->` 在下一个），所以要带状态缓冲：
 *   - 进入注释后吞掉一切直到 `-->`；
 *   - 注释外，把可能是 `<!--` 前缀的结尾（`<`/`<!`/`<!-`）暂留，等更多数据再判定，避免把真实 `<` 误切。
 *
 * 取舍：会连同剥掉回复里合法的 HTML 注释（如代码块内的）。对散文式文档助手这是可接受的默认——正文里
 * 出现裸 HTML 注释本身就不像文档；状态注释泄漏则是每轮必现的观感破绽。若将来需要保留代码注释再细化。
 */
export interface CommentStripper {
  feed(text: string): string;
  flush(): string;
}

const PAT = '<!--';
const CLOSE = '-->';

function trailingPrefixLen(s: string): number {
  const max = Math.min(s.length, PAT.length - 1);
  for (let k = max; k > 0; k--) if (PAT.startsWith(s.slice(s.length - k))) return k;
  return 0;
}

export function createCommentStripper(): CommentStripper {
  let carry = '';
  let inComment = false;

  return {
    feed(text: string): string {
      carry += text;
      let out = '';
      while (carry) {
        if (inComment) {
          const end = carry.indexOf(CLOSE);
          if (end === -1) {
            // 仍在注释内：丢弃注释体，只留结尾 2 字符以防 `-->` 跨 delta 被切开
            carry = carry.slice(-2);
            return out;
          }
          carry = carry.slice(end + CLOSE.length);
          inComment = false;
        } else {
          const start = carry.indexOf(PAT);
          if (start === -1) {
            // 没有完整 `<!--`：把结尾可能是 `<!--` 前缀的部分暂留，其余安全输出
            const hold = trailingPrefixLen(carry);
            out += carry.slice(0, carry.length - hold);
            carry = carry.slice(carry.length - hold);
            return out;
          }
          out += carry.slice(0, start);
          carry = carry.slice(start + PAT.length);
          inComment = true;
        }
      }
      return out;
    },
    flush(): string {
      if (inComment) { carry = ''; return ''; } // 未闭合注释 → 丢弃
      const out = carry; carry = ''; return out; // 暂留的结尾原来不是注释 → 补发
    },
  };
}
