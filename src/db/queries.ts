// Named-block preparation adapted from listmonk's cmd/init.go: readQueries/prepareQueries.
import type { Database, Statement } from "bun:sqlite";
import { maskSql } from "@/db/sql";

export interface QuerySource {
  readonly name: string;
  readonly sql: string;
}
export interface PreparedQueries {
  get(name: string): Statement;
  close(): void;
}

export function prepareNamedQueries(
  db: Database,
  sources: readonly QuerySource[],
): PreparedQueries {
  const statements = new Map<string, Statement>();
  try {
    for (const source of sources) {
      // A marker is a whole line comment in SQL lexical context, not text in a quoted value or block comment.
      const masked = maskSql(source.sql);
      const lines = source.sql.split(/(?<=\n)/);
      let offset = 0;
      let name: string | undefined;
      let block = "";
      const finish = () => {
        if (name === undefined) {
          if (maskSql(block).trim())
            throw new Error(`SQL before the first named query in ${source.name}`);
          return;
        }
        if (statements.has(name)) throw new Error(`Duplicate named query: ${name}`);
        const maskedBlock = maskSql(block);
        if (!maskedBlock.replaceAll(";", "").trim()) throw new Error(`Empty named query: ${name}`);
        const firstEnd = maskedBlock.indexOf(";");
        if (firstEnd >= 0 && maskedBlock.slice(firstEnd + 1).trim()) {
          throw new Error(`Named query ${name} must contain one SQL statement`);
        }
        try {
          statements.set(name, db.prepare(block));
        } catch (error) {
          throw new Error(`Invalid named query ${name} in ${source.name}`, { cause: error });
        }
      };
      for (const line of lines) {
        const marker = /^\s*--\s*name\s*:\s*(.*?)\s*(?:\r?\n)?$/i.exec(line);
        // The marker's initial '--' must be where the mask starts a comment.
        const markerOffset = line.indexOf("--");
        const before = masked.slice(offset, offset + Math.max(0, markerOffset));
        const inLexicalContext =
          marker &&
          !before.trim() &&
          (offset === 0 || masked[offset - 1] === "\n") &&
          // Quoted or block-comment lines are also masked. Examine preceding lexical state below.
          isNormalAt(source.sql, offset + markerOffset);
        if (marker && inLexicalContext) {
          finish();
          name = marker[1]!.trim();
          if (!name) throw new Error(`Empty named query name in ${source.name}`);
          block = "";
        } else block += line;
        offset += line.length;
      }
      finish();
    }
  } catch (error) {
    for (const statement of statements.values()) statement.finalize();
    throw error;
  }
  return {
    get(name) {
      const statement = statements.get(name);
      if (!statement) throw new Error(`Unknown named query: ${name}`);
      return statement;
    },
    close() {
      for (const statement of statements.values()) statement.finalize();
      statements.clear();
    },
  };
}

function isNormalAt(sql: string, offset: number): boolean {
  // A sentinel is visible only when the preceding SQL leaves the lexer in normal state.
  const prefix = sql.slice(0, offset);
  const masked = maskSql(`${prefix}x`);
  return masked.endsWith("x");
}
