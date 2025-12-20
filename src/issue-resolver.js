class IssueResolver {

	/**
	 * @param {AutoMergeAction} action
	 */
	constructor(action) {
		this.action = action
	}

	/**
	 * Closes all issues referenced with GitHub keywords in the commit messages
	 * for the active PR.
	 */
	async resolveIssues() {
		await this._loadCommitMessages()
		for (let issueNumber of this.getFixedIssues()) {
			// https://github.com/SpiderStrategies/Scoreboard/issues/48570
			this.action.core.info(`Closing issue referenced in commits: ${issueNumber}`)
			// GH API works great here (couldn't get ocktokit to work)
			await this.action.exec(`gh issue close ${issueNumber}`)
		}
	}

	/**
	 * @returns {String[]} issue numbers that were resolved in the PR
	 */
	getFixedIssues() {
		let issueNumbers = []
		// https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue#linking-a-pull-request-to-an-issue-using-a-keyword
		const rex = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)(?:[\s\w\/-]+#(\d+))/gi
		this.commitMessages.forEach(m => {
			this.action.core.debug(`Extracting issue numbers from commit message: ${m}`)
			const matches = m.matchAll(rex)
			if (matches) {
				for (const match of matches) {
					// The capture; just the issue number
					issueNumbers.push(match[1])
				}
			}

		})
		return issueNumbers
	}

	async _loadCommitMessages() {
		const commits = await this.action.fetchCommits(this.action.prNumber)
		this.commitMessages = commits.data.map(c => c.commit.message)
		this.action.core.info(`Commit messages are: ${this.commitMessages}`)
	}
}

module.exports = IssueResolver
