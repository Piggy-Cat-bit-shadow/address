export function* splitSqlStatements(source) {
  let start = 0;
  let quote = '';
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag = '';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockCommentDepth) {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = '';
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (next === quote) index += 1;
        else quote = '';
      }
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      continue;
    }
    if (character === '$') {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u);
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (character !== ';') continue;

    const statement = source.slice(start, index).trim();
    if (statement) yield statement;
    start = index + 1;
  }

  const tail = source.slice(start).trim();
  if (tail) yield tail;
}

export const executeSqlStatements = async (database, source, onProgress = () => {}) => {
  let completed = 0;
  for (const statement of splitSqlStatements(source)) {
    await database.exec(statement);
    completed += 1;
    onProgress(completed);
  }
  return completed;
};
