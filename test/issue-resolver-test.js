const tap = require('tap')

const AutoMergeAction = require('../auto-merge-action')
const IssueResolver = require('../issue-resolver')

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
