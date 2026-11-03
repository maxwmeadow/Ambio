export interface LanguageDefinition {
  id: string
  label: string
  extensions: string[]
  preferredExtension: string
  short: string
  color: string
  textColor?: string
  icon: string
}

export const LANGUAGES: LanguageDefinition[] = [
  { id: 'typescript', label: 'TypeScript', extensions: ['.ts'], preferredExtension: '.ts', short: 'TS', color: '#3178c6', textColor: '#fff', icon: 'typescript' },
  { id: 'tsx', label: 'TypeScript React', extensions: ['.tsx'], preferredExtension: '.tsx', short: 'TSX', color: '#61dafb', textColor: '#fff', icon: 'react' },
  { id: 'javascript', label: 'JavaScript', extensions: ['.js', '.mjs', '.cjs'], preferredExtension: '.js', short: 'JS', color: '#f7df1e', textColor: '#303030', icon: 'javascript' },
  { id: 'jsx', label: 'JavaScript React', extensions: ['.jsx'], preferredExtension: '.jsx', short: 'JSX', color: '#61dafb', textColor: '#303030', icon: 'react' },
  { id: 'python', label: 'Python', extensions: ['.py'], preferredExtension: '.py', short: 'PY', color: '#3776ab', textColor: '#fff', icon: 'python' },
  { id: 'go', label: 'Go', extensions: ['.go'], preferredExtension: '.go', short: 'GO', color: '#00add8', textColor: '#fff', icon: 'go' },
  { id: 'rust', label: 'Rust', extensions: ['.rs'], preferredExtension: '.rs', short: 'RS', color: '#dea584', textColor: '#20150f', icon: 'rust' },
  { id: 'csharp', label: 'C# / .NET', extensions: ['.cs'], preferredExtension: '.cs', short: 'C#', color: '#512bd4', textColor: '#fff', icon: 'dotnet' },
  { id: 'cpp', label: 'C++', extensions: ['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hxx', '.hh'], preferredExtension: '.cpp', short: 'C++', color: '#00599c', textColor: '#fff', icon: 'cplusplus' },
  { id: 'c', label: 'C', extensions: ['.c', '.h'], preferredExtension: '.c', short: 'C', color: '#555599', textColor: '#fff', icon: 'c' },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb'], preferredExtension: '.rb', short: 'RB', color: '#cc342d', textColor: '#fff', icon: 'ruby' },
  { id: 'java', label: 'Java / OpenJDK', extensions: ['.java'], preferredExtension: '.java', short: 'JV', color: '#f89820', textColor: '#fff', icon: 'openjdk' },
  { id: 'kotlin', label: 'Kotlin', extensions: ['.kt', '.kts'], preferredExtension: '.kt', short: 'KT', color: '#7f52ff', textColor: '#fff', icon: 'kotlin' },
  { id: 'swift', label: 'Swift', extensions: ['.swift'], preferredExtension: '.swift', short: 'SW', color: '#f05138', textColor: '#fff', icon: 'swift' },
  { id: 'php', label: 'PHP', extensions: ['.php'], preferredExtension: '.php', short: 'PHP', color: '#777bb4', textColor: '#fff', icon: 'php' },
  { id: 'scala', label: 'Scala', extensions: ['.scala', '.sc'], preferredExtension: '.scala', short: 'SC', color: '#dc322f', textColor: '#fff', icon: 'scala' },
  { id: 'groovy', label: 'Groovy', extensions: ['.groovy'], preferredExtension: '.groovy', short: 'GV', color: '#4298b8', textColor: '#fff', icon: 'apachegroovy' },
  { id: 'lua', label: 'Lua', extensions: ['.lua'], preferredExtension: '.lua', short: 'LUA', color: '#000080', textColor: '#fff', icon: 'lua' },
  { id: 'bash', label: 'Shell', extensions: ['.sh', '.bash'], preferredExtension: '.sh', short: 'SH', color: '#4eaa25', textColor: '#fff', icon: 'gnubash' },
  { id: 'elixir', label: 'Elixir', extensions: ['.ex', '.exs'], preferredExtension: '.ex', short: 'EX', color: '#4b275f', textColor: '#fff', icon: 'elixir' },
  { id: 'css', label: 'CSS', extensions: ['.css'], preferredExtension: '.css', short: 'CSS', color: '#663399', textColor: '#fff', icon: 'css' },
  { id: 'scss', label: 'SCSS', extensions: ['.scss'], preferredExtension: '.scss', short: 'SCSS', color: '#cc6699', textColor: '#fff', icon: 'sass' },
  { id: 'sass', label: 'Sass', extensions: ['.sass'], preferredExtension: '.sass', short: 'SASS', color: '#cc6699', textColor: '#fff', icon: 'sass' },
  { id: 'less', label: 'Less', extensions: ['.less'], preferredExtension: '.less', short: 'LESS', color: '#1d365d', textColor: '#fff', icon: 'less' },
  { id: 'markdown', label: 'Markdown', extensions: ['.md', '.mdx'], preferredExtension: '.md', short: 'MD', color: '#5f6f78', textColor: '#fff', icon: 'markdown' },
  { id: 'json', label: 'JSON', extensions: ['.json', '.jsonc'], preferredExtension: '.json', short: 'JSON', color: '#5f6f78', textColor: '#fff', icon: 'json' },
]

const byExtension = new Map(LANGUAGES.flatMap(language => language.extensions.map(ext => [ext, language] as const)))

export function languageDefinition(id: string): LanguageDefinition | undefined {
  return LANGUAGES.find(language => language.id === id.toLowerCase())
}

export function languageFromFilename(filename: string): LanguageDefinition | undefined {
  const lower = filename.toLowerCase()
  const extension = [...byExtension.keys()].sort((a, b) => b.length - a.length).find(ext => lower.endsWith(ext))
  return extension ? byExtension.get(extension) : undefined
}

export function filenameForLanguage(filename: string, languageId: string): string {
  const language = languageDefinition(languageId)
  if (!language) return filename
  const current = languageFromFilename(filename)
  if (current) {
    const ext = current.extensions.find(candidate => filename.toLowerCase().endsWith(candidate))!
    return filename.slice(0, -ext.length) + language.preferredExtension
  }
  return filename + language.preferredExtension
}
