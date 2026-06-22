#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const chalk = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const BruvRepo = require('../core/repo');
const BruvObjects = require('../core/objects');
const SnapshotManager = require('../snapshot/manager');
const PRManager = require('../pr/manager');
const MergeEngine = require('../merge/engine');
const AuthManager = require('../auth/manager');
const BruvServer = require('../api/server');
const { loadConfig, BRUV_CONFIG_DIR, BRUV_CONFIG_FILE, DEFAULTS } = require('../config');
const { shortHash } = require('../utils/hash');

const program = new Command();

program
  .name('bruv')
  .description('Source control that\'s easier than git — with native PRs, private repos, snapshots, and AI-powered merging.')
  .version('0.1.0');

// ========== INIT ==========
program
  .command('init')
  .description('Initialize a new bruv repository')
  .option('-p, --private', 'Make the repository private')
  .option('-r, --remote <url>', 'Set a remote URL')
  .option('--author <name>', 'Set author name')
  .option('--email <email>', 'Set author email')
  .option('-m, --message <msg>', 'Initial commit message', 'Initial commit')
  .action((opts) => {
    try {
      const cwd = process.cwd();
      if (BruvRepo.isInitialized(cwd)) {
        console.log(chalk.yellow('Repository already initialized.'));
        return;
      }
      BruvRepo.init(cwd, opts);
      console.log(chalk.green('✔ Initialized bruv repository'));
      console.log(chalk.dim('  .bruv/ directory created'));
      console.log(chalk.dim('  .bruvignore created'));
      console.log(chalk.dim('  main snapshot created'));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== ADD ==========
program
  .command('add <files...>')
  .description('Stage files for commit (use . to add all)')
  .option('--danger', 'Override security checks (NOT RECOMMENDED)', false)
  .action((files, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository. Run `bruv init` first.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const count = repo.add(files, opts);
      console.log(chalk.green(`✔ Staged ${count} file(s)`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== RM ==========
program
  .command('rm <files...>')
  .description('Remove files from staging')
  .action((files) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      repo.rm(files);
      console.log(chalk.green(`✔ Removed ${files.length} file(s) from staging`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== COMMIT ==========
program
  .command('commit')
  .description('Create a commit with staged changes')
  .requiredOption('-m, --message <msg>', 'Commit message')
  .option('--author <name>', 'Author name')
  .option('--email <email>', 'Author email')
  .action((opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const result = repo.commit(opts.message, opts);
      console.log(chalk.green(`✔ Committed ${chalk.bold(shortHash(result.commitHash))}`));
      console.log(chalk.dim(`  ${opts.message}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== STATUS ==========
program
  .command('status')
  .description('Show repository status')
  .action(() => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const status = repo.status();

      console.log(chalk.bold(`On snapshot ${chalk.cyan(status.snapshot)}`));
      console.log();

      if (status.staged.length > 0) {
        console.log(chalk.green('  Staged:'));
        for (const f of status.staged) console.log(chalk.green(`    + ${f}`));
      }
      if (status.removed.length > 0) {
        console.log(chalk.red('  Removed:'));
        for (const f of status.removed) console.log(chalk.red(`    - ${f}`));
      }
      if (status.modified.length > 0) {
        console.log(chalk.yellow('  Modified (not staged):'));
        for (const f of status.modified) console.log(chalk.yellow(`    ~ ${f}`));
      }
      if (status.untracked.length > 0) {
        console.log(chalk.blue('  Untracked:'));
        for (const f of status.untracked) console.log(chalk.blue(`    ? ${f}`));
      }
      if (status.staged.length === 0 && status.removed.length === 0 && status.modified.length === 0 && status.untracked.length === 0) {
        console.log(chalk.dim('  Nothing to commit, working tree clean'));
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== LOG ==========
program
  .command('log')
  .description('Show commit history')
  .option('-n, --count <n>', 'Number of commits to show', '20')
  .action((opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const log = repo.log(parseInt(opts.count));

      for (const commit of log) {
        console.log(chalk.yellow(`commit ${commit.hash}`));
        console.log(chalk.dim(`Author: ${commit.author}`));
        console.log(chalk.dim(`Date:   ${commit.timestamp}`));
        console.log();
        console.log(`    ${commit.message}`);
        console.log();
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== DIFF ==========
program
  .command('diff')
  .description('Show staged changes')
  .action(() => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const diffs = repo.diff();

      if (diffs.length === 0) {
        console.log(chalk.dim('No changes detected.'));
        return;
      }

      for (const d of diffs) {
        if (d.type === 'added') {
          console.log(chalk.green(`+ ${d.file}`));
        } else if (d.type === 'deleted') {
          console.log(chalk.red(`- ${d.file}`));
        } else {
          console.log(chalk.yellow(`~ ${d.file}`));
        }
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== SNAPSHOT ==========
const snapshotCmd = program
  .command('snapshot')
  .description('Manage snapshots (branch-like, merge-safe)');

snapshotCmd
  .command('create <name>')
  .description('Create a new snapshot from the current HEAD')
  .option('-m, --message <msg>', 'Snapshot message', '')
  .option('--author <name>', 'Author name')
  .option('--force', 'Overwrite if exists', false)
  .action((name, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const result = repo.snapshot(name, opts);
      console.log(chalk.green(`✔ Created snapshot '${chalk.bold(name)}'`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

snapshotCmd
  .command('list')
  .description('List all snapshots')
  .action(() => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const sm = new SnapshotManager(repoPath);
      const snapshots = sm.list();
      const head = new BruvObjects(repoPath).getHead();

      if (snapshots.length === 0) {
        console.log(chalk.dim('No snapshots found.'));
        return;
      }

      for (const name of snapshots) {
        const snap = sm.get(name);
        const isCurrent = head?.name === name;
        const prefix = isCurrent ? chalk.green('* ') : '  ';
        const privacyIndicator = snap?.isPrivate ? chalk.red(' [private]') : '';
        console.log(`${prefix}${chalk.cyan(name)}${privacyIndicator} ${chalk.dim(shortHash(snap?.commitHash || ''))} ${chalk.dim(snap?.message || '')}`);
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

snapshotCmd
  .command('switch <name>')
  .description('Switch to a snapshot (checkout its files)')
  .action((name) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      repo.switchSnapshot(name);
      console.log(chalk.green(`✔ Switched to snapshot '${chalk.bold(name)}'`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

snapshotCmd
  .command('delete <name>')
  .description('Delete a snapshot')
  .action((name) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const sm = new SnapshotManager(repoPath);
      const deleted = sm.delete(name);
      if (deleted) {
        console.log(chalk.green(`✔ Deleted snapshot '${name}'`));
      } else {
        console.log(chalk.yellow(`Snapshot '${name}' not found.`));
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

snapshotCmd
  .command('merge <sources...>')
  .description('Merge two or more snapshots (conflict-free by default)')
  .option('-s, --strategy <type>', 'Merge strategy: union, custom, automated', 'union')
  .option('-m, --message <msg>', 'Merge commit message', '')
  .option('--author <name>', 'Author name')
  .action(async (sources, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);

      if (opts.strategy === 'union') {
        const sm = new SnapshotManager(repoPath);
        const mergedCommitHash = sm.mergeSnapshots(sources, opts.author || 'user', opts.message);
        console.log(chalk.green(`✔ Merged snapshots: ${sources.join(', ')}`));
        console.log(chalk.dim(`  Merge commit: ${shortHash(mergedCommitHash)}`));
      } else if (opts.strategy === 'custom') {
        const result = await repo.merge(sources[0], sources[1], { strategy: 'custom' });
        if (result.needsResolution) {
          console.log(chalk.yellow(`Conflicts detected in ${result.conflicts.length} file(s):`));
          for (const c of result.conflicts) {
            console.log(chalk.yellow(`  ${c.file}`));
          }
          console.log();
          console.log('Use `bruv merge resolve` to choose which version to keep for each file.');
        }
      } else if (opts.strategy === 'automated') {
        const result = await repo.merge(sources[0], sources[1], { strategy: 'automated', message: opts.message, author: opts.author });
        console.log(chalk.green(`✔ Auto-merged snapshots: ${sources.join(', ')}`));
        console.log(chalk.dim(`  Merge commit: ${shortHash(result.mergeCommitHash)}`));
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== BRANCH-SHARE ==========
program
  .command('branch-share <snapshot> <username>')
  .description('Share a private snapshot with another user (requires auth)')
  .action((snapshot, username) => {
    try {
      const auth = new AuthManager();
      if (!auth.isAuthenticated()) {
        console.error(chalk.red('✘ Not authenticated. Run `bruv auth` first.'));
        process.exit(1);
      }
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const sm = new SnapshotManager(repoPath);
      sm.shareWithUser(snapshot, username);
      console.log(chalk.green(`✔ Shared snapshot '${snapshot}' with ${username}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== TAG ==========
const tagCmd = program
  .command('tag')
  .description('Manage tags (merge-safe pointers to commits)');

tagCmd
  .command('create <name>')
  .description('Create a tag at the current HEAD')
  .option('-m, --message <msg>', 'Tag message', '')
  .option('--author <name>', 'Author name')
  .action((name, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const result = repo.tag(name, opts);
      console.log(chalk.green(`✔ Created tag '${chalk.bold(name)}' at ${shortHash(result.commitHash)}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

tagCmd
  .command('list')
  .description('List all tags')
  .action(() => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const objects = new BruvObjects(repoPath);
      const tags = objects.listTags();
      if (tags.length === 0) {
        console.log(chalk.dim('No tags found.'));
        return;
      }
      for (const name of tags) {
        const tag = objects.readTag(name);
        console.log(chalk.cyan(name) + chalk.dim(` -> ${shortHash(tag?.commitHash || '')} ${tag?.message || ''}`));
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== PR ==========
const prCmd = program
  .command('pr')
  .description('Manage pull requests (native, first-class)');

prCmd
  .command('create')
  .description('Create a pull request')
  .requiredOption('-t, --title <title>', 'PR title')
  .option('-d, --description <desc>', 'PR description', '')
  .option('-s, --source <snapshot>', 'Source snapshot')
  .option('--target <snapshot>', 'Target snapshot', 'main')
  .option('--author <name>', 'Author name')
  .option('--private', 'Make the PR private', false)
  .option('--reviewers <reviewers...>', 'Initial reviewers', [])
  .action((opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      const objects = new BruvObjects(repoPath);
      const head = objects.getHead();
      const source = opts.source || head?.name || 'main';
      const prHash = prm.create({
        title: opts.title,
        description: opts.description,
        sourceSnapshot: source,
        targetSnapshot: opts.target,
        author: opts.author || 'unknown',
        isPrivate: opts.private,
        reviewers: opts.reviewers,
      });
      console.log(chalk.green(`✔ Created PR #${chalk.bold(prHash.slice(0, 7))}: ${opts.title}`));
      console.log(chalk.dim(`  ${source} → ${opts.target}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

prCmd
  .command('list')
  .description('List pull requests')
  .option('-s, --status <status>', 'Filter by status (open, closed, merged)', null)
  .action((opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      const prs = prm.list(opts.status);
      if (prs.length === 0) {
        console.log(chalk.dim('No pull requests found.'));
        return;
      }
      for (const pr of prs) {
        const statusColor = pr.status === 'open' ? chalk.green : pr.status === 'merged' ? chalk.cyan : chalk.red;
        const privacyIndicator = pr.isPrivate ? chalk.red(' [private]') : '';
        console.log(`${statusColor(`#${pr.id}`)}${privacyIndicator} ${chalk.bold(pr.title)}`);
        console.log(chalk.dim(`  ${pr.sourceSnapshot} → ${pr.targetSnapshot} | ${pr.status} | by ${pr.author}`));
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

prCmd
  .command('show <id>')
  .description('Show PR details')
  .action((id) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      const pr = prm.get(id);
      if (!pr) { console.error(chalk.red(`PR #${id} not found.`)); process.exit(1); }

      const statusColor = pr.status === 'open' ? chalk.green : pr.status === 'merged' ? chalk.cyan : chalk.red;
      console.log(chalk.bold(`PR #${pr.id}: ${pr.title}`));
      console.log(`Status: ${statusColor(pr.status)}`);
      console.log(`Source: ${chalk.cyan(pr.sourceSnapshot)} → Target: ${chalk.cyan(pr.targetSnapshot)}`);
      console.log(`Author: ${pr.author}`);
      if (pr.isPrivate) console.log(chalk.red('Private'));
      if (pr.reviewers?.length) console.log(`Reviewers: ${pr.reviewers.join(', ')}`);
      if (pr.approvals?.length) console.log(`Approvals: ${pr.approvals.join(', ')}`);
      if (pr.description) console.log(`\n${pr.description}`);
      if (pr.comments?.length) {
        console.log(chalk.bold('\nComments:'));
        for (const c of pr.comments) {
          console.log(chalk.dim(`  ${c.author} (${c.timestamp}):`));
          console.log(`  ${c.body}`);
        }
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

prCmd
  .command('merge <id>')
  .description('Merge a pull request')
  .option('-s, --strategy <type>', 'Merge strategy: union, custom, automated', 'union')
  .option('--author <name>', 'Author name')
  .action(async (id, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      const result = await prm.merge(id, opts.author || 'unknown', opts.strategy);

      if (result.needsResolution) {
        console.log(chalk.yellow(`Conflicts detected in ${result.conflicts.length} file(s):`));
        for (const c of result.conflicts) {
          console.log(chalk.yellow(`  ${c.file}`));
          console.log(chalk.dim(`    Version A and Version B differ`));
        }
        console.log();
        console.log('Choose a resolution strategy:');
        console.log(chalk.cyan('  bruv pr merge <id> --strategy custom') + '    - Pick which version to keep per file');
        console.log(chalk.cyan('  bruv pr merge <id> --strategy automated') + '  - Let AI decide');
      } else {
        console.log(chalk.green(`✔ Merged PR #${id}`));
        console.log(chalk.dim(`  Merge commit: ${shortHash(result.mergedCommitHash)}`));
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

prCmd
  .command('close <id>')
  .description('Close a pull request without merging')
  .action((id) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      prm.close(id, 'user');
      console.log(chalk.green(`✔ Closed PR #${id}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

prCmd
  .command('comment <id> <body>')
  .description('Add a comment to a PR')
  .option('--author <name>', 'Comment author', 'user')
  .action((id, body, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      prm.addComment(id, opts.author, body);
      console.log(chalk.green(`✔ Comment added to PR #${id}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

prCmd
  .command('approve <id>')
  .description('Approve a pull request')
  .option('--approver <name>', 'Approver name', 'user')
  .action((id, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      prm.approve(id, opts.approver);
      console.log(chalk.green(`✔ Approved PR #${id}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== PR-SHARE ==========
program
  .command('pr-share <prId> <username>')
  .description('Share a private PR with another user (requires auth)')
  .action((prId, username) => {
    try {
      const auth = new AuthManager();
      if (!auth.isAuthenticated()) {
        console.error(chalk.red('✘ Not authenticated. Run `bruv auth` first.'));
        process.exit(1);
      }
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const prm = new PRManager(repoPath);
      prm.shareWithUser(prId, username);
      console.log(chalk.green(`✔ Shared PR #${prId} with ${username}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== MERGE RESOLVE ==========
program
  .command('merge-resolve <source> <target>')
  .description('Interactively resolve merge conflicts between two snapshots')
  .option('--strategy <type>', 'Resolution strategy: custom or automated', 'custom')
  .action(async (source, target, opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);

      if (opts.strategy === 'automated') {
        const result = await repo.merge(source, target, { strategy: 'automated' });
        console.log(chalk.green('✔ Automated merge complete'));
        console.log(chalk.dim(`  Merge commit: ${shortHash(result.mergeCommitHash)}`));
      } else {
        const result = await repo.merge(source, target, { strategy: 'custom' });
        if (!result.needsResolution) {
          console.log(chalk.green('✔ No conflicts detected - merge is clean!'));
          return;
        }

        console.log(chalk.yellow(`\n${result.conflicts.length} conflict(s) detected:\n`));

        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        const choices = {};
        for (const conflict of result.conflicts) {
          console.log(chalk.bold(`File: ${conflict.file}`));
          console.log(chalk.cyan('  A) Version from ' + source + ':'));
          console.log(chalk.dim('  ' + conflict.contentA.split('\n').slice(0, 5).join('\n  ') + (conflict.contentA.split('\n').length > 5 ? '\n  ...' : '')));
          console.log(chalk.cyan('  B) Version from ' + target + ':'));
          console.log(chalk.dim('  ' + conflict.contentB.split('\n').slice(0, 5).join('\n  ') + (conflict.contentB.split('\n').length > 5 ? '\n  ...' : '')));

          const answer = await new Promise(resolve => {
            rl.question(chalk.bold('  Keep which version? [A/b]: '), resolve);
          });
          choices[conflict.file] = answer.trim().toLowerCase() === 'b' ? 'b' : 'a';
          console.log();
        }
        rl.close();

        const mergedTreeHash = result.mergeData.resolve(choices);
        const config = loadConfig();
        const author = config.BRUV_USER_NAME || 'unknown';

        const mergeCommitHash = repo.objects.writeCommit({
          tree: mergedTreeHash,
          parents: [result.mergeData.onlyA ? source : target, target],
          message: `Custom merge: ${source} into ${target}`,
          author,
          metadata: { mergeType: 'custom' },
        });

        console.log(chalk.green('✔ Custom merge complete'));
        console.log(chalk.dim(`  Merge commit: ${shortHash(mergeCommitHash)}`));
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== REMOTE ==========
const remoteCmd = program
  .command('remote')
  .description('Manage remote repositories');

remoteCmd
  .command('add <name> <url>')
  .description('Add a remote')
  .action((name, url) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      repo.addRemote(name, url);
      console.log(chalk.green(`✔ Added remote '${name}' -> ${url}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

remoteCmd
  .command('remove <name>')
  .description('Remove a remote')
  .action((name) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      repo.removeRemote(name);
      console.log(chalk.green(`✔ Removed remote '${name}'`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

remoteCmd
  .command('list')
  .description('List remotes')
  .action(() => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const remotes = repo.listRemotes();
      const entries = Object.entries(remotes);
      if (entries.length === 0) {
        console.log(chalk.dim('No remotes configured.'));
        return;
      }
      for (const [name, url] of entries) {
        console.log(`${chalk.cyan(name)}\t${url}`);
      }
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== PUSH ==========
program
  .command('push')
  .description('Push commits to remote')
  .option('--danger', 'Override security checks', false)
  .option('-r, --remote <name>', 'Remote name to push to')
  .action(async (opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const result = await repo.push(opts);
      console.log(chalk.green('✔ Pushed to remote'));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== PULL ==========
program
  .command('pull')
  .description('Pull commits from remote')
  .option('-r, --remote <name>', 'Remote name to pull from')
  .action(async (opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd());
      if (!repoPath) { console.error(chalk.red('Not a bruv repository.')); process.exit(1); }
      const repo = new BruvRepo(repoPath);
      const result = await repo.pull(opts);
      console.log(chalk.green('✔ Pulled from remote'));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== CLONE ==========
program
  .command('clone <url> [dest]')
  .description('Clone a remote repository')
  .action(async (url, dest) => {
    try {
      const destPath = dest || path.basename(url, '.git') || 'repo';
      const fullDest = path.resolve(process.cwd(), destPath);
      await BruvRepo.clone(url, fullDest);
      console.log(chalk.green(`✔ Cloned into ${destPath}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== AUTH ==========
const authCmd = program
  .command('auth')
  .description('Authenticate with bruv API');

authCmd
  .command('login')
  .description('Login with username/password')
  .requiredOption('-u, --username <username>', 'Username')
  .requiredOption('-p, --password <password>', 'Password')
  .action(async (opts) => {
    try {
      const auth = new AuthManager();
      const result = await auth.login(opts.username, opts.password);
      console.log(chalk.green(`✔ Logged in as ${opts.username}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

authCmd
  .command('register')
  .description('Register a new account')
  .requiredOption('-u, --username <username>', 'Username')
  .requiredOption('-p, --password <password>', 'Password')
  .option('-e, --email <email>', 'Email address')
  .action(async (opts) => {
    try {
      const auth = new AuthManager();
      const result = await auth.register(opts.username, opts.password, opts.email);
      console.log(chalk.green(`✔ Registered and logged in as ${opts.username}`));
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

authCmd
  .command('logout')
  .description('Logout')
  .action(() => {
    const auth = new AuthManager();
    auth.logout();
    console.log(chalk.green('✔ Logged out'));
  });

authCmd
  .command('status')
  .description('Show authentication status')
  .action(() => {
    const auth = new AuthManager();
    if (auth.isAuthenticated()) {
      const user = auth.getCurrentUser();
      console.log(chalk.green(`✔ Authenticated as ${user?.username || 'unknown'}`));
    } else {
      console.log(chalk.yellow('Not authenticated. Run `bruv auth login` to authenticate.'));
    }
  });

// ========== SERVER ==========
program
  .command('server')
  .description('Start the bruv API server on port 2658')
  .option('-p, --port <port>', 'Port to listen on', '2658')
  .action(async (opts) => {
    try {
      const repoPath = BruvRepo.findRepo(process.cwd()) || process.cwd();
      const port = parseInt(opts.port);
      const server = new BruvServer(repoPath, port);
      await server.start();
      console.log(chalk.dim('Press Ctrl+C to stop'));

      process.on('SIGINT', () => {
        server.stop();
        console.log(chalk.dim('\nServer stopped.'));
        process.exit(0);
      });
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// ========== CONFIG ==========
program
  .command('config')
  .description('View or set bruv configuration')
  .option('-l, --list', 'List all configuration values')
  .option('--get <key>', 'Get a specific config value')
  .option('--set <key=value>', 'Set a config value')
  .action((opts) => {
    try {
      const config = loadConfig();

      if (opts.list) {
        console.log(chalk.bold('bruv configuration:'));
        console.log(chalk.dim(`  Config file: ${BRUV_CONFIG_FILE}`));
        console.log();
        for (const [key, value] of Object.entries(config)) {
          const isAI = key.includes('API_KEY') || key.includes('KEY');
          const displayValue = isAI && value ? '••••••••' : value;
          console.log(`  ${chalk.cyan(key)} = ${displayValue}`);
        }
        return;
      }

      if (opts.get) {
        const value = config[opts.get];
        if (value !== undefined) {
          console.log(value);
        } else {
          console.error(chalk.red(`Unknown config key: ${opts.get}`));
          process.exit(1);
        }
        return;
      }

      if (opts.set) {
        const [key, ...valueParts] = opts.set.split('=');
        const value = valueParts.join('=');
        if (!fs.existsSync(BRUV_CONFIG_DIR)) {
          fs.mkdirSync(BRUV_CONFIG_DIR, { recursive: true });
        }
        // Append to config file
        let content = '';
        if (fs.existsSync(BRUV_CONFIG_FILE)) {
          content = fs.readFileSync(BRUV_CONFIG_FILE, 'utf8');
        }
        // Replace existing or append
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content += `\n${key}=${value}`;
        }
        fs.writeFileSync(BRUV_CONFIG_FILE, content.trim() + '\n', 'utf8');
        console.log(chalk.green(`✔ Set ${key} = ${value}`));
        return;
      }

      // Default: show help
      program.commands.find(c => c.name() === 'config').help();
    } catch (e) {
      console.error(chalk.red('✘ ') + e.message);
      process.exit(1);
    }
  });

// Parse
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
