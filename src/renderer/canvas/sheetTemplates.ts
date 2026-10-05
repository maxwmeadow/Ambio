/**
 * Starter sheets (WORK sheet-templates): drawn skeletons for the changes
 * people ask agents for most, written in the sheet Markdown format
 * (archd api/sheet_markdown.go) so New Sheet from Markdown… drafts them and
 * the person only renames what is in angle brackets.
 */
export interface SheetTemplate {
  id: string
  label: string
  markdown: string
}

export const SHEET_TEMPLATES: SheetTemplate[] = [
  {
    id: 'endpoint',
    label: 'Add an endpoint',
    markdown: `# Add <endpoint>

<What the endpoint lets a client do.>

## Add
- class \`<Name>Handler\` at \`<src/api/name.ts>\` - handles the request
  - \`handle(request): Response\` - validates input and calls the service
- class \`<Name>Service\` at \`<src/services/name.ts>\` - the work behind it

## Connections
- \`<Name>Handler\` CALLS \`<Name>Service\`
`,
  },
  {
    id: 'extract-service',
    label: 'Extract a service',
    markdown: `# Extract <service>

Move <responsibility> out of <current system> behind its own boundary.

## Add
- system \`<Service>\` at \`<src/service/>\` - owns <responsibility>
- service \`<Service> API\` - the only way in

## Connections
- \`<current system>\` DEPENDS_ON \`<Service>\` - through its API only
`,
  },
  {
    id: 'queue-consumer',
    label: 'Add a queue consumer',
    markdown: `# Consume <topic>

React to <event> without blocking the caller.

## Add
- class \`<Topic>Consumer\` at \`<src/workers/topic.ts>\` - reads <topic>
  - \`handle(message)\` - idempotent; safe to retry
- data_store \`<topic> dead letters\` - messages that keep failing

## Connections
- \`<Topic>Consumer\` CALLS \`<handling system>\`
`,
  },
  {
    id: 'split-system',
    label: 'Split a system',
    markdown: `# Split <system>

<system> does two jobs; give each its own home.

## Add
- system \`<first part>\` at \`<src/first/>\` - <its job>
- system \`<second part>\` at \`<src/second/>\` - <its job>

## Remove
- system \`<system>\`

## Connections
- \`<first part>\` DEPENDS_ON \`<second part>\`
`,
  },
]
