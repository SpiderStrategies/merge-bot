const tap = require('tap')
const { mockCore } = require('gh-action-components')

const pushWithRetry = require('../src/push-with-retry')
const { createMockShell } = require('./test-helpers')

/**
 * Builds a shell whose `git push` fails for the first [rejections] calls,
 * recording every command so tests can assert the retry sequence.
 */
function createRejectingShell(core, rejections) {
	const commands = []
	let pushes = 0

	const shell = createMockShell(core, (cmd) => {
		commands.push(cmd)
		if (cmd.startsWith('git push')) {
			pushes++
			if (pushes <= rejections) {
				throw new Error(`! [rejected] (non-fast-forward)`)
			}
			return 'pushed'
		}
		return ''
	})

	return { shell, commands }
}

tap.test('pushWithRetry', async t => {

	t.test('fetches and resets before merging so the merge lands on the remote tip', async t => {
		const core = mockCore({})
		const { shell, commands } = createRejectingShell(core, 0)

		await pushWithRetry({
			shell,
			core,
			branch: 'main',
			merge: async () => { commands.push('<merge>') }
		})

		t.same(commands, [
			'git checkout main',
			'git fetch origin main',
			'git reset --hard origin/main',
			'<merge>',
			'git push origin main'
		], 'should refresh main before merging, then push')
	})

	t.test('returns the push output', async t => {
		const core = mockCore({})
		const { shell } = createRejectingShell(core, 0)

		const result = await pushWithRetry({
			shell,
			core,
			branch: 'main',
			merge: async () => {}
		})

		t.equal(result, 'pushed', 'should return the output of the push')
	})

	t.test('rebuilds against the new tip when a concurrent run wins the push', async t => {
		const core = mockCore({})
		const { shell, commands } = createRejectingShell(core, 1)

		await pushWithRetry({
			shell,
			core,
			branch: 'main',
			merge: async () => { commands.push('<merge>') }
		})

		t.equal(commands.filter(c => c === 'git push origin main').length, 2,
			'should push twice - once rejected, once accepted')
		t.equal(commands.filter(c => c === 'git fetch origin main').length, 2,
			'should re-fetch before the retry rather than reusing the stale tip')
		t.equal(commands.filter(c => c === 'git reset --hard origin/main').length, 2,
			'should discard the rejected attempt instead of merging on top of it')
		t.equal(commands.filter(c => c === '<merge>').length, 2,
			'should redo the merge against the new tip')
	})

	t.test('gives up after the configured number of attempts', async t => {
		const core = mockCore({})
		const { shell, commands } = createRejectingShell(core, 5)

		await t.rejects(
			pushWithRetry({
				shell,
				core,
				branch: 'main',
				merge: async () => {},
				attempts: 3
			}),
			/non-fast-forward/,
			'should rethrow the push rejection once attempts run out')

		t.equal(commands.filter(c => c === 'git push origin main').length, 3,
			'should stop after 3 attempts rather than retrying forever')
	})

	t.test('defaults to PUSH_ATTEMPTS attempts', async t => {
		const core = mockCore({})
		const { shell, commands } = createRejectingShell(core, 99)

		await t.rejects(pushWithRetry({
			shell,
			core,
			branch: 'main',
			merge: async () => {}
		}))

		t.equal(commands.filter(c => c === 'git push origin main').length,
			pushWithRetry.PUSH_ATTEMPTS,
			'should use PUSH_ATTEMPTS when no attempts option is given')
	})
})
