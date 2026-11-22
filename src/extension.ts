import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

interface CFProblem {
  index: string;   // "A", "B", "C" …
  name: string;
}

interface CFContest {
  id: number;
  name: string;
  problems: CFProblem[];
}

interface ProblemData {
  title: string;
  markdown: string;
  sampleInputs: string[];
  sampleOutputs: string[];
}

let out: vscode.OutputChannel;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = (lib as typeof https).get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          ...headers,
        },
      },
      (res) => {
        // Follow redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          resolve(get(res.headers.location, headers));
          res.resume();
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
  });
}

// ── Codeforces API ────────────────────────────────────────────────────────────

async function fetchContestInfo(contestId: string): Promise<CFContest | null> {
  const url = `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1&showUnofficial=false`;

  try {
    const raw = await get(url);
    out.appendLine(`[api] standings: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);

    if (json.status !== "OK") {
      out.appendLine(`[api] Error: ${json.comment}`);
      return null;
    }

    const { contest, problems } = json.result;
    return {
      id: contest.id,
      name: contest.name,
      problems: (problems as CFProblem[]).map((p) => ({
        index: p.index,
        name: p.name,
      })),
    };
  } catch (e) {
    out.appendLine(`[api] Error: ${e}`);
    return null;
  }
}

// ── Problem page scraper ──────────────────────────────────────────────────────

function extractBetween(html: string, open: string, close: string): string | null {
  const start = html.indexOf(open);
  if (start === -1) {
    return null;
  }
  const end = html.indexOf(close, start + open.length);
  if (end === -1) {
    return null;
  }
  return html.slice(start + open.length, end);
}

function extractTag(
  html: string,
  tag: string,
  attrSnippet = ""
): string | null {
  const open = attrSnippet ? `<${tag} ${attrSnippet}` : `<${tag}>`;
  const startIdx = html.indexOf(open);
  if (startIdx === -1) {
    return null;
  }
  // Find the matching close tag, respecting nesting
  const closeTag = `</${tag}>`;
  let depth = 0;
  let i = startIdx;
  while (i < html.length) {
    const nextOpen = html.indexOf(`<${tag}`, i + 1);
    const nextClose = html.indexOf(closeTag, i + 1);
    if (nextClose === -1) {
      return null;
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen;
    } else {
      if (depth === 0) {
        const contentStart = html.indexOf(">", startIdx) + 1;
        return html.slice(contentStart, nextClose);
      }
      depth--;
      i = nextClose;
    }
  }
  return null;
}

// ── HTML → Markdown ───────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&le;/g, "≤")
    .replace(/&ge;/g, "≥")
    .replace(/&times;/g, "×")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 10))
    );
}

function htmlToMarkdown(html: string): string {
  if (!html) {
    return "";
  }

  let md = html;

  // Section titles → ## headings
  md = md.replace(
    /<div class="section-title">([\s\S]*?)<\/div>/gi,
    "\n## $1\n\n"
  );

  // <pre> → fenced code block
  md = md.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    return "\n```\n" + text + "\n```\n\n";
  });

  // CF-specific spans
  md = md.replace(/<span class="tex-font-style-tt">([\s\S]*?)<\/span>/gi, "`$1`");
  md = md.replace(/<span class="tex-font-style-bf">([\s\S]*?)<\/span>/gi, "**$1**");
  md = md.replace(/<span class="tex-font-style-it">([\s\S]*?)<\/span>/gi, "*$1*");
  md = md.replace(/<span class="tex-font-style-ol">([\s\S]*?)<\/span>/gi, "~~$1~~");

  // Superscripts
  md = md.replace(/<sup>([\s\S]*?)<\/sup>/gi, (_, c) => "^" + c.replace(/<[^>]+>/g, ""));

  // Bold / italic
  md = md.replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**");
  md = md.replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**");
  md = md.replace(/<em>([\s\S]*?)<\/em>/gi, "*$1*");
  md = md.replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*");

  // Inline code
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Lists
  md = md.replace(/<li>([\s\S]*?)<\/li>/gi, (_, c) => "- " + c.trim() + "\n");
  md = md.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  // Paragraphs
  md = md.replace(/<p>([\s\S]*?)<\/p>/gi, "$1\n\n");

  // Line breaks
  md = md.replace(/<br\s*\/?>/gi, "\n");

  // Strip remaining tags (keep $ math as-is for MathJax/KaTeX renderers)
  md = md.replace(/<[^>]+>/g, "");

  md = decodeEntities(md);
  md = md.replace(/\n{3,}/g, "\n\n").trim();

  return md;
}

// ── Problem scraper ───────────────────────────────────────────────────────────

async function fetchProblemData(
  contestId: string,
  index: string
): Promise<ProblemData> {
  const url = `https://codeforces.com/contest/${contestId}/problem/${index}`;
  out.appendLine(`[problem] Fetching ${url}`);

  const empty: ProblemData = {
    title: index,
    markdown: "*Problem statement could not be fetched.*",
    sampleInputs: [],
    sampleOutputs: [],
  };

  try {
    const html = await get(url);

    // Check for login wall
    if (html.includes("handle=\"handleOrEmail\"") || html.includes("/enter?back=")) {
      out.appendLine(`[problem:${index}] Login required`);
      return { ...empty, markdown: "*Problem statement requires login.*" };
    }

    // Extract problem-statement div
    const psHtml = extractTag(html, "div", 'class="problem-statement"');
    if (!psHtml) {
      out.appendLine(`[problem:${index}] Could not find problem-statement div`);
      return empty;
    }

    // Title
    const titleMatch = psHtml.match(/<div class="title">([^<]+)<\/div>/);
    const title = titleMatch
      ? titleMatch[1].replace(/^[A-Z0-9]+\.\s*/, "").trim()
      : index;

    // Time / memory limits
    const timeLimitMatch = psHtml.match(
      /<div class="time-limit">[\s\S]*?<\/div>([\s\S]*?)<\/div>/
    );
    const memLimitMatch = psHtml.match(
      /<div class="memory-limit">[\s\S]*?<\/div>([\s\S]*?)<\/div>/
    );
    const timeLimit = timeLimitMatch
      ? timeLimitMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";
    const memLimit = memLimitMatch
      ? memLimitMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    // Sample tests
    const sampleInputs: string[] = [];
    const sampleOutputs: string[] = [];
    const sampleTestsRe =
      /<div class="input">\s*<div[^>]*>[^<]*<\/div>\s*<pre[^>]*>([\s\S]*?)<\/pre>/g;
    const sampleOutputsRe =
      /<div class="output">\s*<div[^>]*>[^<]*<\/div>\s*<pre[^>]*>([\s\S]*?)<\/pre>/g;

    let m: RegExpExecArray | null;
    while ((m = sampleTestsRe.exec(psHtml)) !== null) {
      sampleInputs.push(
        decodeEntities(m[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim()
      );
    }
    while ((m = sampleOutputsRe.exec(psHtml)) !== null) {
      sampleOutputs.push(
        decodeEntities(m[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim()
      );
    }

    out.appendLine(
      `[problem:${index}] "${title}" — ${sampleInputs.length} sample(s)`
    );

    // Remove sample-tests section before converting to markdown
    const statementHtml = psHtml
      .replace(/<div class="sample-tests">[\s\S]*?(?=<div class="note">|$)/, "")
      .replace(/<div class="header">[\s\S]*?<\/div>\s*<\/div>/, "");

    // Build markdown
    let markdown = htmlToMarkdown(statementHtml);

    // Append limits and samples to markdown
    const metaLines: string[] = [];
    if (timeLimit) { metaLines.push(`**Time limit:** ${timeLimit}`); }
    if (memLimit) { metaLines.push(`**Memory limit:** ${memLimit}`); }

    let samplesSection = "\n## Samples\n\n";
    for (let i = 0; i < sampleInputs.length; i++) {
      samplesSection += `**Input ${i + 1}:**\n\`\`\`\n${sampleInputs[i]}\n\`\`\`\n\n`;
      if (sampleOutputs[i] !== undefined) {
        samplesSection += `**Output ${i + 1}:**\n\`\`\`\n${sampleOutputs[i]}\n\`\`\`\n\n`;
      }
    }

    markdown =
      (metaLines.length ? metaLines.join(" · ") + "\n\n---\n\n" : "") +
      markdown +
      samplesSection;

    return { title, markdown, sampleInputs, sampleOutputs };
  } catch (e) {
    out.appendLine(`[problem:${index}] Error: ${e}`);
    return empty;
  }
}

// ── File helpers ──────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\s+/g, "_");
}

function extractContestId(input: string): string | null {
  // https://codeforces.com/contest/1234 or /1234/
  const urlMatch = input.match(/codeforces\.com\/contest\/(\d+)/);
  if (urlMatch) {
    return urlMatch[1];
  }
  // Bare number
  if (/^\d+$/.test(input.trim())) {
    return input.trim();
  }
  return null;
}

function buildCpp(
  problem: CFProblem,
  contestId: string,
  data: ProblemData
): string {
  const baseName = `${problem.index}_${sanitizeFilename(data.title)}`;
  const url = `https://codeforces.com/contest/${contestId}/problem/${problem.index}`;
  return `/*
 * ${problem.index}. ${data.title}
 * ${url}
 *
 * Sample input: ${problem.index}_input1.txt
 * Run: g++ -O2 -o sol ${baseName}.cpp && ./sol < ${problem.index}_input1.txt
 */

#include <bits/stdc++.h>
using namespace std;

int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(NULL);
    // freopen("${problem.index}_input1.txt", "r", stdin);

    int t;
    cin >> t;
    while (t--) {

    }

    return 0;
}
`;
}

function buildMarkdownHeader(
  problem: CFProblem,
  contestId: string,
  data: ProblemData
): string {
  const url = `https://codeforces.com/contest/${contestId}/problem/${problem.index}`;
  return (
    `# ${problem.index}. ${data.title}\n\n` +
    `[Open on Codeforces](${url})\n\n---\n\n`
  );
}

// ── Extension ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  out = vscode.window.createOutputChannel("Codeforces Contest");

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codeforces-contest.joinContest",
      async () => {
        out.clear();
        out.show(true);

        // 1. Contest URL / ID
        const input = await vscode.window.showInputBox({
          prompt: "Enter Codeforces contest URL or ID",
          placeHolder:
            "https://codeforces.com/contest/2060 or 2060",
          validateInput: (val) => {
            if (!val?.trim()) {
              return "Please enter a contest URL or ID";
            }
            if (!extractContestId(val)) {
              return "Invalid URL or contest ID (must be a number)";
            }
            return undefined;
          },
        });

        if (!input) {
          return;
        }

        const contestId = extractContestId(input)!;

        // 2. Workspace root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {
          vscode.window.showErrorMessage(
            "No workspace folder open. Please open a folder first."
          );
          return;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // 3. Fetch contest + all problem data
        type FetchResult = {
          contest: CFContest;
          problemData: ProblemData[];
        };

        const result = await vscode.window.withProgress<FetchResult | null>(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Fetching contest ${contestId}`,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Loading contest info…" });
            const contest = await fetchContestInfo(contestId);
            if (!contest) {
              return null;
            }

            progress.report({
              message: `Fetching ${contest.problems.length} problems…`,
            });
            const problemData = await Promise.all(
              contest.problems.map((p) =>
                fetchProblemData(contestId, p.index)
              )
            );

            return { contest, problemData };
          }
        );

        if (!result) {
          vscode.window.showErrorMessage(
            `Could not fetch contest ${contestId}. Check the "Codeforces Contest" output panel.`
          );
          return;
        }

        const { contest, problemData } = result;
        const folderName = sanitizeFilename(contest.name).replace(/\s+/g, "_");
        const contestDir = path.join(workspaceRoot, folderName);

        if (!fs.existsSync(contestDir)) {
          fs.mkdirSync(contestDir, { recursive: true });
        }

        // 4. Write files
        const cppFiles: string[] = [];
        const mdFiles: string[] = [];

        for (let i = 0; i < contest.problems.length; i++) {
          const problem = contest.problems[i];
          const data = problemData[i];
          const baseName = `${problem.index}_${sanitizeFilename(data.title)}`;

          // .cpp
          const cppPath = path.join(contestDir, baseName + ".cpp");
          if (!fs.existsSync(cppPath)) {
            fs.writeFileSync(cppPath, buildCpp(problem, contestId, data));
            out.appendLine(`[cpp] ${baseName}.cpp`);
          } else {
            out.appendLine(`[cpp] ${baseName}.cpp — skipped (exists)`);
          }
          cppFiles.push(cppPath);

          // Sample input files: A_input1.txt, A_input2.txt …
          for (let j = 0; j < data.sampleInputs.length; j++) {
            const inputPath = path.join(
              contestDir,
              `${problem.index}_input${j + 1}.txt`
            );
            if (!fs.existsSync(inputPath)) {
              fs.writeFileSync(inputPath, data.sampleInputs[j] + "\n");
              out.appendLine(`[txt] ${problem.index}_input${j + 1}.txt`);
            }
          }

          // Sample output files: A_output1.txt, A_output2.txt …
          for (let j = 0; j < data.sampleOutputs.length; j++) {
            const outputPath = path.join(
              contestDir,
              `${problem.index}_output${j + 1}.txt`
            );
            if (!fs.existsSync(outputPath)) {
              fs.writeFileSync(outputPath, data.sampleOutputs[j] + "\n");
              out.appendLine(`[txt] ${problem.index}_output${j + 1}.txt`);
            }
          }

          // .md
          const mdPath = path.join(contestDir, baseName + ".md");
          if (!fs.existsSync(mdPath)) {
            const mdContent =
              buildMarkdownHeader(problem, contestId, data) + data.markdown;
            fs.writeFileSync(mdPath, mdContent);
            out.appendLine(`[md]  ${baseName}.md`);
          } else {
            out.appendLine(`[md]  ${baseName}.md — skipped (exists)`);
          }
          mdFiles.push(mdPath);
        }

        // 5. Open files: .cpp editors + .md previews side-by-side
        for (const cppPath of cppFiles) {
          const doc = await vscode.workspace.openTextDocument(cppPath);
          await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.One,
          });
        }

        for (const mdPath of mdFiles) {
          await vscode.commands.executeCommand(
            "markdown.showPreviewToSide",
            vscode.Uri.file(mdPath)
          );
        }

        vscode.window.showInformationMessage(
          `Contest "${contest.name}" ready! ${contest.problems.length} problems in "${folderName}".`
        );
      }
    )
  );
}

export function deactivate() {}
