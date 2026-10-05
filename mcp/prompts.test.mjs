import assert from 'node:assert/strict'
import test from 'node:test'
import { LOOP_PROMPTS, loopPromptText } from './prompts.ts'

test('every advertised loop prompt has instructions, and they name real tools', () => {
  const tools = /get_architecture|edit_sheet|plan_element|get_build_plan|start_work|update_work/
  for (const prompt of LOOP_PROMPTS) {
    const text = loopPromptText(prompt.name, {})
    assert.ok(text, prompt.name)
    assert.match(text, tools, prompt.name)
  }
  assert.equal(loopPromptText('nope'), null)
})

test('arguments are woven into the instruction', () => {
  assert.match(loopPromptText('propose', { goal: 'add a job queue' }), /^Propose "add a job queue" on the Ambio map/)
  assert.match(loopPromptText('implement', { sheet: 'Payment flow' }), /get_build_plan with sheet "Payment flow"/)
  assert.match(loopPromptText('implement', {}), /the user names/)
})
