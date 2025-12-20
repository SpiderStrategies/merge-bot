const core = require('@actions/core')
const github = require('@actions/github')

const AutoMergeAction = require('./automerge')
const BranchMaintainerAction = require('./maintain-branches')

const { pull_request, repository } = github.context.payload
const configFile = core.getInput('config-file', { required: true })

const { number: prNumber, title, base, head, user } = pull_request

async function run() {
	// Build options for both phases
	const options = {
		configFile,
		pullRequest: pull_request,
		repository,
		prNumber,
		prAuthor: user.login,
		prTitle: title,
		prBranch: head.ref,
		baseBranch: base.ref,
		prCommitSha: head.sha,
	}

	// Phase 1: Merge forward
	const automerge = new AutoMergeAction(options)
	await automerge.run()

	// Phase 2: Maintain branch-here pointers (only if PR was merged)
	if (pull_request.merged) {
		const maintainer = new BranchMaintainerAction({
			configFile,
			pullRequest: pull_request,
		})
		await maintainer.run()
	} else {
		core.info('PR was not merged, skipping branch maintenance')
	}
}

run()

