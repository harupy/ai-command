interface DiffLine {
  oldLineNum: number | null;
  newLineNum: number | null;
  changeType: "add" | "delete" | "context";
  content: string;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface FileDiff {
  oldFile: string;
  newFile: string;
  hunks: DiffHunk[];
}

class DiffParser {
  private lines: string[];
  private currentLine: number = 0;

  constructor(diffText: string) {
    this.lines = diffText.split("\n");
  }

  parse(): FileDiff[] {
    const fileDiffs: FileDiff[] = [];

    while (this.currentLine < this.lines.length) {
      if (this.lines[this.currentLine].startsWith("diff --git")) {
        const fileDiff = this.parseFileDiff();
        if (fileDiff) {
          fileDiffs.push(fileDiff);
        }
      } else {
        this.currentLine++;
      }
    }

    return fileDiffs;
  }

  private parseFileDiff(): FileDiff | null {
    const diffLine = this.lines[this.currentLine];
    const match = diffLine.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (!match) {
      this.currentLine++;
      return null;
    }

    const oldFile = match[1];
    const newFile = match[2];
    this.currentLine++;

    // Skip optional headers
    while (this.currentLine < this.lines.length) {
      const line = this.lines[this.currentLine];
      if (line.startsWith("---") || line.startsWith("+++")) {
        break;
      }
      if (line.startsWith("@@")) {
        break;
      }
      if (line.startsWith("diff --git")) {
        return { oldFile, newFile, hunks: [] };
      }
      this.currentLine++;
    }

    // Skip --- and +++ lines
    if (
      this.currentLine < this.lines.length &&
      this.lines[this.currentLine].startsWith("---")
    ) {
      this.currentLine++;
    }
    if (
      this.currentLine < this.lines.length &&
      this.lines[this.currentLine].startsWith("+++")
    ) {
      this.currentLine++;
    }

    // Parse hunks
    const hunks: DiffHunk[] = [];
    while (this.currentLine < this.lines.length) {
      const line = this.lines[this.currentLine];
      if (line.startsWith("@@")) {
        const hunk = this.parseHunk();
        if (hunk) {
          hunks.push(hunk);
        }
      } else if (line.startsWith("diff --git")) {
        break;
      } else {
        this.currentLine++;
      }
    }

    return { oldFile, newFile, hunks };
  }

  private parseHunk(): DiffHunk | null {
    const hunkHeader = this.lines[this.currentLine];
    const match = hunkHeader.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    );
    if (!match) {
      this.currentLine++;
      return null;
    }

    const oldStart = parseInt(match[1]);
    const oldCount = match[2] ? parseInt(match[2]) : 1;
    const newStart = parseInt(match[3]);
    const newCount = match[4] ? parseInt(match[4]) : 1;

    this.currentLine++;

    const lines: DiffLine[] = [];
    let oldLineNum = oldStart;
    let newLineNum = newStart;

    while (this.currentLine < this.lines.length) {
      const line = this.lines[this.currentLine];

      if (line.startsWith("@@") || line.startsWith("diff --git")) {
        break;
      }

      if (line.startsWith("Binary files")) {
        this.currentLine++;
        continue;
      }

      if (line.startsWith("-")) {
        lines.push({
          oldLineNum: oldLineNum,
          newLineNum: null,
          changeType: "delete",
          content: line.length > 1 ? line.substring(1) : "",
        });
        oldLineNum++;
      } else if (line.startsWith("+")) {
        lines.push({
          oldLineNum: null,
          newLineNum: newLineNum,
          changeType: "add",
          content: line.length > 1 ? line.substring(1) : "",
        });
        newLineNum++;
      } else if (line.startsWith(" ")) {
        lines.push({
          oldLineNum: oldLineNum,
          newLineNum: newLineNum,
          changeType: "context",
          content: line.length > 1 ? line.substring(1) : "",
        });
        oldLineNum++;
        newLineNum++;
      } else if (line.startsWith("\\")) {
        // "No newline at end of file" - skip
      } else {
        // Context line without space prefix
        lines.push({
          oldLineNum: oldLineNum,
          newLineNum: newLineNum,
          changeType: "context",
          content: line,
        });
        oldLineNum++;
        newLineNum++;
      }

      this.currentLine++;
    }

    return { oldStart, oldCount, newStart, newCount, lines };
  }
}

class TextFormatter {
  private lineWidth: number;
  private showLineNumbers: boolean;
  private lineNumWidth: number;
  private markerWidth: number = 2;
  private contentWidth: number;

  constructor(lineWidth: number = 80, showLineNumbers: boolean = true) {
    this.lineWidth = lineWidth;
    this.showLineNumbers = showLineNumbers;
    this.lineNumWidth = showLineNumbers ? 4 : 0;
    this.contentWidth = lineWidth - this.lineNumWidth - this.markerWidth - 1;
  }

  formatFileDiff(fileDiff: FileDiff): string {
    const lines: string[] = [];

    // File header
    const fileName = fileDiff.newFile || fileDiff.oldFile;
    lines.push(`\nFile: ${fileName}`);
    lines.push("=".repeat(this.lineWidth * 2 + 3));

    // Column headers
    const oldHeader = this.center("Old", this.lineWidth);
    const newHeader = this.center("New", this.lineWidth);
    lines.push(`${oldHeader} │ ${newHeader}`);
    lines.push("─".repeat(this.lineWidth) + "─┼─" + "─".repeat(this.lineWidth));

    // Process hunks
    for (let i = 0; i < fileDiff.hunks.length; i++) {
      const hunk = fileDiff.hunks[i];

      // Add hunk separator if not first
      if (i > 0) {
        lines.push(
          " ".repeat(this.lineWidth) + " │ " + " ".repeat(this.lineWidth)
        );
      }

      // Process lines in pairs
      const pairedLines = this.pairDiffLines(hunk.lines);
      for (const [oldLine, newLine] of pairedLines) {
        const formatted = this.formatLinePair(oldLine, newLine);
        lines.push(formatted);
      }
    }

    return lines.map(s => s.trimEnd()).join("\n");
  }

  private pairDiffLines(
    lines: DiffLine[]
  ): Array<[DiffLine | null, DiffLine | null]> {
    const pairs: Array<[DiffLine | null, DiffLine | null]> = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.changeType === "context") {
        pairs.push([line, line]);
        i++;
      } else {
        // Collect consecutive deletes and adds
        const deleteLines: DiffLine[] = [];
        const addLines: DiffLine[] = [];

        // Collect all consecutive deletes
        while (i < lines.length && lines[i].changeType === "delete") {
          deleteLines.push(lines[i]);
          i++;
        }

        // Collect all consecutive adds
        while (i < lines.length && lines[i].changeType === "add") {
          addLines.push(lines[i]);
          i++;
        }

        // Pair them up
        const maxLength = Math.max(deleteLines.length, addLines.length);
        for (let j = 0; j < maxLength; j++) {
          const oldLine = j < deleteLines.length ? deleteLines[j] : null;
          const newLine = j < addLines.length ? addLines[j] : null;
          pairs.push([oldLine, newLine]);
        }
      }
    }

    return pairs;
  }

  private formatLinePair(
    oldLine: DiffLine | null,
    newLine: DiffLine | null
  ): string {
    const oldText = this.formatSingleLine(oldLine, true);
    const newText = this.formatSingleLine(newLine, false);
    return `${oldText} │ ${newText}`;
  }

  private formatSingleLine(line: DiffLine | null, isOld: boolean): string {
    if (!line) {
      return " ".repeat(this.lineWidth);
    }

    // Line number
    let lineNumStr = "";
    if (this.showLineNumbers) {
      const lineNum = isOld ? line.oldLineNum : line.newLineNum;
      if (lineNum !== null) {
        lineNumStr = lineNum.toString().padStart(this.lineNumWidth) + " ";
      } else {
        lineNumStr = " ".repeat(this.lineNumWidth);
      }
    }

    // Change marker
    let marker = "  ";
    if (line.changeType === "delete" && isOld) {
      marker = "- ";
    } else if (line.changeType === "add" && !isOld) {
      marker = "+ ";
    }

    // Content
    let content = line.content || "";
    if (content.length > this.contentWidth) {
      content = content.substring(0, this.contentWidth - 1) + "…";
    } else {
      content = content.padEnd(this.contentWidth);
    }

    return lineNumStr + marker + content;
  }

  private center(text: string, width: number): string {
    const padding = Math.max(0, width - text.length);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  }

  formatDiff(fileDiffs: FileDiff[]): string {
    return fileDiffs.map(fd => this.formatFileDiff(fd)).join("\n");
  }
}

export function formatDiff(diffHunk: string): string {
  const parser = new DiffParser(diffHunk);
  const fileDiffs = parser.parse();
  const formatter = new TextFormatter();
  return formatter.formatDiff(fileDiffs);
}
