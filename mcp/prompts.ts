/**
 * One-word ways into the loop for every host that shows MCP prompts as slash
 * commands (/ambio:propose, /ambio:implement, /ambio:review). Each is the
 * workflow the tools already support, written as an instruction, so an agent
 * does not have to discover the order of calls on its own:
 *
 *   propose   - draw the change on a sheet and wait for the person (agent → human)
 *   implement - build what a sheet says, verified by compare (human → agent)
 *   review    - check that the code and the map still agree (code keeps both honest)
 */

export interface LoopPrompt {
  name: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
}

export const LOOP_PROMPTS: LoopPrompt[] = [
  {
    name: 'propose',
    description: 'Draw a change on a sheet for the user to confirm before any code is written.',
    arguments: [{ name: 'goal', description: 'What the change should achieve', required: true }],
  },
  {
    name: 'implement',
    description: "Build what a sheet asks for, and check the code against it until it matches.",
    arguments: [{ name: 'sheet', description: 'Sheet name or ID (defaults to the one the user names)', required: false }],
  },
  {
    name: 'review',
    description: 'Check that the code and the architecture map still agree, and report where they do not.',
    arguments: [],
  },
]

const quoted = (value: string | undefined) => (value && value.trim() ? `"${value.trim()}"` : '')

export function loopPromptText(name: string, args: Record<string, string | undefined> = {}): string | null {
  switch (name) {
    case 'propose': {
      const goal = quoted(args.goal) || 'the change the user describes'
      return [
        `Propose ${goal} on the Ambio map before writing any code.`,
        '',
        '1. Read the map: get_architecture (overview, then systems or neighbors for the parts this touches). Note what already exists so you draw changes, not duplicates.',
        '2. Create a sheet named after the goal: edit_sheet op "create" with name and purpose, and members for the live systems and files it involves.',
        '3. Draw what is new with plan_element on that sheet: one element per new system, service, class, file or data store, with declaredPath and, for classes, members (signature and intent). Draw what should go with edit_sheet op "remove".',
        '4. Tell the user, in one short message, what you drew and why, and that it is waiting for them under "To review" in the sheet rail.',
        '5. Stop. Do not edit code until the user confirms. A rejection comes with a reason; read it (start_work briefs you on decisions) and redraw rather than argue.',
        '',
        'Draw the decision, not every file: systems and the boundaries between them first, details only where the user needs them to decide.',
      ].join('\n')
    }
    case 'implement': {
      const sheet = quoted(args.sheet)
      return [
        `Implement the Ambio sheet ${sheet || 'the user names'}.`,
        '',
        `1. Read it: get_build_plan with sheet ${sheet || '<name>'} for what to build, where it lives and what must be removed. Only confirmed elements are part of the order; proposals still awaiting the user are not.`,
        '2. start_work with a one-sentence goal before editing. Read the mapChanges and decisions it returns: they are what the user changed or decided since you last worked here.',
        '3. Build it. Put new code where the sheet says (declaredPath, the system it is drawn in). Remove what the sheet removes, including what only it used. Report progress with update_work; when it returns mapChanges, the user changed or decided something while you worked - follow it before going on.',
        '4. Check: edit_sheet op "compare". Bind each new live node to its planned element (op "bind"), apply nesting the sheet asks for (op "apply_nesting"), and compare again until nothing is open.',
        '5. update_work with what you did and the checks you ran, then tell the user. Do not resolve the sheet yourself unless they ask.',
        '',
        'If the sheet is wrong or impossible, say so and why instead of building something else.',
      ].join('\n')
    }
    case 'review':
      return [
        'Review whether the code and the Ambio map still agree.',
        '',
        '1. get_architecture scope "changes": what people and agents changed on the map recently.',
        '2. edit_sheet op "list", then op "compare" on each open sheet: what is drawn but not built, and what was built differently.',
        '3. get_architecture scope "cross_dependencies" for the systems involved: dependencies the map does not show, or that contradict a sheet.',
        '4. Report to the user as a short list, most important first: each disagreement, the files that show it, and whether the code or the map should change. Do not change either until they say which.',
      ].join('\n')
    default:
      return null
  }
}
