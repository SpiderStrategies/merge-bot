const tap = require('tap')

const AutoMergeAction = require('../src/automerge')
const IssueResolver = require('../src/issue-resolver')

class ActionStub extends AutoMergeAction {

}

tap.test(`getFixedIssues`, async t => {
	const action = new ActionStub()
	const ir = new IssueResolver(action)
	ir.commitMessages = [
		// extra whitespace, multiple issues in same comment
		'this commit fixes  #234 and also ReSolves \t #235',
		// new lines
		'this commit resolved \n #678',
		// No regex match
		'this commit did nothing useful',
		// Allow \q, -, and / before the # sign for repo references like this
		'Fixes octo-org/octo-repo#100'
	]
	const numbers = ir.getFixedIssues()
	t.same(["234", "235", "678", "100"], numbers)
})

tap.test(`single Issue`, async t => {
	const action = new ActionStub()
	const ir = new IssueResolver(action)
	ir.commitMessages = ['This commit fixes  #270 for real']
	const fixedIssues = ir.getFixedIssues()
	for (let issue_number of fixedIssues) {
		t.same("270", issue_number)
	}
})

tap.test('resolveIssues', async t => {
	const { mockCore } = require('gh-action-components')

	t.test('closes all issues found in commits', async t => {
		const closedIssues = []

		class TestAction extends ActionStub {
			async fetchCommits(prNum) {
				return {
					data: [
						{ commit: { message: 'fixes #100' } },
						{ commit: { message: 'resolves #200 and closes #300' } }
					]
				}
			}

			async exec(cmd) {
				if (cmd.startsWith('gh issue close')) {
					const issueNum = cmd.split(' ')[3]
					closedIssues.push(issueNum)
				}
			}
		}

		const action = new TestAction()
		action.core = mockCore({})
		action.prNumber = 123

		const ir = new IssueResolver(action)
		await ir.resolveIssues()

		t.same(closedIssues, ['100', '200', '300'], 'should close all issues')
	})

	t.test('does nothing when no issues found', async t => {
		let execCalled = false

		class TestAction extends ActionStub {
			async fetchCommits() {
				return {
					data: [
						{ commit: { message: 'no issues here' } }
					]
				}
			}

			async exec(cmd) {
				if (cmd.startsWith('gh issue close')) {
					execCalled = true
				}
			}
		}

		const action = new TestAction()
		action.core = mockCore({})
		action.prNumber = 456

		const ir = new IssueResolver(action)
		await ir.resolveIssues()

		t.notOk(execCalled, 'should not call gh issue close when no issues found')
	})
})
