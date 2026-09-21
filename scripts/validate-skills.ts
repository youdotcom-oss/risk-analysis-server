import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS_DIR = join(import.meta.dir, '..', 'skills')

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

type Finding = { file: string; problem: string }

function validateSkill(dir: string): Finding[] {
  const findings: Finding[] = []
  const skillFile = join(SKILLS_DIR, dir, 'SKILL.md')
  if (!existsSync(skillFile)) {
    findings.push({ file: dir, problem: 'missing SKILL.md' })
    return findings
  }
  const content = readFileSync(skillFile, 'utf8')

  // frontmatter: must open with --- and close with ---
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match || match[1] === undefined) {
    findings.push({ file: dir, problem: 'missing or malformed YAML frontmatter' })
    return findings
  }
  const frontmatter = match[1]

  const get = (field: string): string | undefined => {
    const m = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
    return m?.[1]?.trim()
  }

  const name = get('name')
  if (name) {
    if (!NAME_RE.test(name)) {
      findings.push({
        file: dir,
        problem: `name "${name}" is not kebab-case (lowercase letters, digits, single hyphens)`,
      })
    }
    if (name.length > 64) {
      findings.push({ file: dir, problem: `name exceeds 64 characters (${name.length})` })
    }
    if (name !== dir) {
      findings.push({ file: dir, problem: `name "${name}" does not match directory "${dir}"` })
    }
  } else {
    findings.push({ file: dir, problem: 'missing name field' })
  }

  const description = get('description')
  if (!description) {
    findings.push({ file: dir, problem: 'missing description field' })
  } else if (description.length > 1024) {
    findings.push({ file: dir, problem: `description exceeds 1024 characters (${description.length})` })
  }

  const compatibility = get('compatibility')
  if (compatibility && compatibility.length > 500) {
    findings.push({ file: dir, problem: `compatibility exceeds 500 characters (${compatibility.length})` })
  }

  // body size guidance: SKILL.md under 500 lines
  const body = content.slice(content.indexOf('---', 3))
  if (body.split('\n').length > 500) {
    findings.push({ file: dir, problem: `SKILL.md body exceeds 500 lines (${body.split('\n').length})` })
  }

  // referenced files exist (scripts/, references/, assets/ one level deep)
  const refs = [...content.matchAll(/(?:scripts|references|assets)\/[\w.-]+/g)]
  for (const ref of refs) {
    const path = join(SKILLS_DIR, dir, ref[0])
    if (!existsSync(path)) {
      findings.push({ file: dir, problem: `referenced file missing: ${ref[0]}` })
    }
  }

  return findings
}

const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

if (dirs.length === 0) {
  console.error('no skills found under skills/')
  process.exit(1)
}

let failed = 0
for (const dir of dirs.sort()) {
  const findings = validateSkill(dir)
  if (findings.length === 0) {
    console.log(`ok  ${dir}`)
  } else {
    failed++
    for (const finding of findings) {
      console.error(`FAIL ${dir}: ${finding.problem}`)
    }
  }
}

if (failed > 0) {
  console.error(`${failed} skill(s) failed validation`)
  process.exit(1)
}
