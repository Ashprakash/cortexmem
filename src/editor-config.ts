import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const CORTEXMEM_MARKER = '<!-- cortexmem-auto-generated -->';

function generateInstructions(): string {
  return `## Memory & Context (cortexmem)

This project uses **cortexmem** for persistent memory across sessions.

### On session start:
- Call \`get_context\` (no args) to load project overview and recent context.
- If working on a specific topic, call \`get_context\` with a relevant query.

### During work:
- When you make an architectural decision, save it:
  \`save_context({ context_type: "decision", content: "..." })\`
- When you discover a constraint or gotcha:
  \`save_context({ context_type: "constraint", content: "..." })\`
- When you learn something non-obvious about the codebase:
  \`save_context({ context_type: "discovery", content: "..." })\`
- When noting current work state or progress:
  \`save_context({ context_type: "state", content: "..." })\`
- Include \`related_files\` when saving file-specific context.

### On session end:
- Call \`summarize_session\` to compact this session's context for future use.`;
}

export async function generateEditorConfigs(
  repoRoot: string,
): Promise<string[]> {
  const generated: string[] = [];
  const instructions = generateInstructions();

  // CLAUDE.md for Claude Code
  const claudeMdPath = join(repoRoot, 'CLAUDE.md');
  if (await writeOrAppendConfig(claudeMdPath, instructions)) {
    generated.push('CLAUDE.md');
  }

  // .cursorrules for Cursor
  const cursorPath = join(repoRoot, '.cursorrules');
  if (await writeOrAppendConfig(cursorPath, instructions)) {
    generated.push('.cursorrules');
  }

  // codex.md for Codex
  const codexPath = join(repoRoot, 'codex.md');
  if (await writeOrAppendConfig(codexPath, instructions)) {
    generated.push('codex.md');
  }

  return generated;
}

async function writeOrAppendConfig(
  filePath: string,
  instructions: string,
): Promise<boolean> {
  const block = `${CORTEXMEM_MARKER}\n${instructions}\n${CORTEXMEM_MARKER}`;

  if (existsSync(filePath)) {
    const existing = await readFile(filePath, 'utf-8');

    // Already has our block — replace it (in case instructions changed)
    if (existing.includes(CORTEXMEM_MARKER)) {
      const regex = new RegExp(
        `${escapeRegex(CORTEXMEM_MARKER)}[\\s\\S]*?${escapeRegex(CORTEXMEM_MARKER)}`,
      );
      const updated = existing.replace(regex, block);
      await writeFile(filePath, updated, 'utf-8');
      return true;
    }

    // File exists but no marker — append
    await writeFile(filePath, existing.trimEnd() + '\n\n' + block + '\n', 'utf-8');
    return true;
  }

  // New file
  await writeFile(filePath, block + '\n', 'utf-8');
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
