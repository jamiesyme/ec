#!/usr/bin/env node

import arg             from 'arg';
import { spawn }       from 'child_process';
import { stripIndent } from 'common-tags';
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
}                      from 'fs/promises';
import { Agent }       from 'http';
import fetch           from 'node-fetch';
import { homedir }     from 'os';
import Path            from 'path';
import { cwd }         from 'process';
import prompts         from 'prompts'
import Toml            from 'toml';


async function spawnAsync (...args)
{
	const child = spawn(...args);
	await new Promise((resolve, reject) => {
		child.on('exit', resolve);
		child.on('error', reject);
	});
}

// Pt == Pass-through
async function spawnPtAsync (command, args, options)
{
	log(`${command} ${(args || []).join(' ')}`);
	return await spawnAsync(command, args, { ...options, stdio: 'inherit' });
}

const agent = new Agent({ socketPath : '/var/lib/lxd/unix.socket' });

const lxdFetch = async function (path, options) {
	if (options?.json) {
		options = {
			...options,
			body    : JSON.stringify(options.json),
			headers : {
				'Content-Type': 'application/json',
				...options.headers,
			},
		};
	}
	return await fetch(`http://0.0.0.0${path}`, { ...options, agent });
};

function getConfigDirPath ()
{
	return Path.join(
		process.env.XDG_CONFIG_HOME ?? Path.join(homedir(), '.config'),
		'ec',
	);
}

function getContainersPath ()
{
	return Path.join(getConfigDirPath(), 'containers');
}

function getContainerPath (name)
{
	return Path.join(getContainersPath(), name);
}

function resolveTilde (path)
{
	if (path[0] === '~') {
		return Path.join(homedir(), path.slice(1));
	} else {
		return path;
	}
}

function applyTilde (path)
{
	if (path.startsWith(homedir())) {
		return Path.join('~', path.slice(homedir().length));
	} else {
		return path;
	}
}

async function runDefaultEditor (path)
{
	const editor = process.env.EDITOR ?? 'vi';
	await spawnAsync(editor, [path], { stdio: 'inherit' });
}

function log (str = '')
{
	console.log(stripIndent(str));
}

function parseArgs ()
{
	return arg({
		'--container' : String,
		'--help'      : Boolean,
		'-h'          : '--help',
	});
}

function displayHelp ()
{
	return log(`
Description:
  Easy container controls for LXC instances.

  The container to be controlled will be looked up automatically using the
  current working directory. Use the \`project-path\` field in container configs
  to map directories (see ~/.config/ec/containers).

  The default command is "login".

Usage:
  ec [options] [command]

Commands:
  init        Configure new container
  login       Auto-start and log into container
  provision   Bootstrap container
  stop        Stop container if running

Options:
      --container   Bypass cwd-based container lookup
  -h, --help        display this help and exit
	`);
}

function findNearestKeyValueInPathMap (pathMap, path)
{
	while (true) {
		if (pathMap[path]) {
			return [path, pathMap[path]];
		}
		if (path === '/') {
			return [];
		}
		path = Path.dirname(path);
	}
}

async function findContainerByCwd (cwd)
{
	const containers = await readdir(getContainersPath());

	const projectMap = {};

	for (const container of containers) {
		const config = await loadContainerConfig(container);
		projectMap[config['project-path']] = container;
	}

	const [path, container] = findNearestKeyValueInPathMap(projectMap, cwd);
	return container ?? null;
}

async function getContainerByCwd (cwd)
{
	const name = await findContainerByCwd(cwd);
	if (!name) {
		return log('No container found within current directory.');
	}
	return name;
}

async function loadContainerConfig (name)
{
	const defaultConfig = {
		mounts: [],
	};

	const configPath = Path.join(getContainerPath(name), 'config.toml');
	const configStr = await readFile(configPath, 'utf-8');
	const config = {
		...defaultConfig,
		...Toml.parse(configStr),
	};

	if (!config['project-path']) {
		throw new Error(
			`container config at "${configPath}" does not include \`project-path\``
		);
	}
	config['project-path'] = resolveTilde(config['project-path']);

	for (const src in config.mounts) {
		const dest = config.mounts[src];
		delete config.mounts[src];
		config.mounts[resolveTilde(src)] = dest;
	}

	return config;
}

async function mapCwdToContainerMount (name, cwd)
{
	const config = await loadContainerConfig(name);

	const [srcDir, destDir] = findNearestKeyValueInPathMap(config.mounts, cwd);
	if (!srcDir || !destDir) {
		return null;
	}

	return Path.join(destDir, Path.relative(srcDir, cwd));
}

async function getContainerStatus (name)
{
	const res = await lxdFetch(`/1.0/instances/${name}`);
	const json = await res.json();
	return json.metadata.status.toLowerCase();
}

async function startContainer (name)
{
	let res = await lxdFetch(`/1.0/instances/${name}/state`, {
		method : 'PUT',
		json   : { action: 'start' },
	});
	let json = await res.json();

	// json.operation == '/1.0/operations/66e83638-9dd7-4a26-aef2-5462814869a1'
	await lxdFetch(`${json.operation}/wait`);
}

async function autoStartContainer (name = null)
{
	name = name ?? await getContainerByCwd(cwd());

	const status = await getContainerStatus(name);
	if (status === 'running') {
		return;
	}

	await startContainer(name);
}

async function stopContainer (name)
{
	let res = await lxdFetch(`/1.0/instances/${name}/state`, {
		method : 'PUT',
		json   : { action: 'stop' },
	});
	let json = await res.json();

	// json.operation == '/1.0/operations/66e83638-9dd7-4a26-aef2-5462814869a1'
	await lxdFetch(`${json.operation}/wait`);
}

async function autoStopContainer (name = null)
{
	name = name ?? await getContainerByCwd(cwd());

	const status = await getContainerStatus(name);
	if (status !== 'running') {
		return;
	}

	await stopContainer(name);
}

async function logIntoContainer (name = null)
{
	name = name ?? await getContainerByCwd(cwd());

	await autoStartContainer(name);

	const lxcArgs = ['exec', name, '--', 'sudo', '--login', '--user', 'ubuntu'];

	const initialCwd = await mapCwdToContainerMount(name, cwd());
	if (initialCwd) {
		lxcArgs.push(`EC_INITIAL_DIR=${initialCwd}`);
	}

	const process = spawn('lxc', lxcArgs, { stdio: 'inherit' });

	await new Promise((resolve, reject) => {
		process.on('exit', resolve);
		process.on('error', reject);
	});
}

async function initContainer (name = null)
{
	const cwdIsHome = cwd() === homedir();

	let onCancel = () => {
		process.exit(1);
	};

	if (!name) {
		const res = await prompts({
			type    : 'text',
			name    : 'name',
			message : 'Container name?',
			initial : cwdIsHome
				? undefined
				: Path.basename(cwd()),
		}, { onCancel });
		name = res.name;
	}

	const containerDir = getContainerPath(name);
	await mkdir(containerDir);

	const defaultConfigStr = stripIndent`
		project-path = "${applyTilde(cwd())}"

		[mounts]
		"${applyTilde(cwd())}" = "/opt/${name}"
	`;
	const configPath = Path.join(containerDir, 'config.toml');
	await writeFile(configPath, defaultConfigStr);

	await copyFile(
		Path.join(getConfigDirPath(), 'bootstrap-root.template.sh'),
		Path.join(containerDir, 'bootstrap-root.sh'),
	);
	await copyFile(
		Path.join(getConfigDirPath(), 'bootstrap-user.template.sh'),
		Path.join(containerDir, 'bootstrap-user.sh'),
	);

	onCancel = async () => {
		await rm(containerDir, { recursive: true });
		process.exit(1);
	};

	const { edit } = await prompts({
		type    : 'confirm',
		name    : 'edit',
		message : 'Edit default config?',
		initial : true,
	}, { onCancel });
	if (edit) {
		await runDefaultEditor(configPath);
	}

	const { editBsRoot } = await prompts({
		type    : 'confirm',
		name    : 'editBsRoot',
		message : 'Edit bootstrap-root.sh?',
		initial : true,
	}, { onCancel });
	if (editBsRoot) {
		await runDefaultEditor(Path.join(containerDir, 'bootstrap-root.sh'));
	}

	const { editBsUser } = await prompts({
		type    : 'confirm',
		name    : 'editBsUser',
		message : 'Edit bootstrap-user.sh?',
		initial : true,
	}, { onCancel });
	if (editBsUser) {
		await runDefaultEditor(Path.join(containerDir, 'bootstrap-user.sh'));
	}

	const { provision } = await prompts({
		type    : 'confirm',
		name    : 'provision',
		message : 'Provision container?',
		initial : true,
	}, { onCancel });
	if (provision) {
		await provisionContainer(name);
	}
}

async function provisionContainer (name = null)
{
	name = name ?? await getContainerByCwd(cwd());

	const config = await loadContainerConfig(name);

	// Create container
	await spawnPtAsync('lxc', [
		'init', 'ubuntu-minimal:lts', name,
		'-p', 'default',
		'-p', 'ubuntu-mapped',
	]);

	// Create mounts
	for (const [src, dest] of Object.entries(config.mounts)) {
		const deviceName = dest;
		await spawnPtAsync('lxc', [
			'config',
			'device',
			'add',
			name,
			deviceName,
			'disk',
			`path=${dest}`,
			`source=${src}`,
		]);
	}

	// Start container
	await autoStartContainer(name);

	// Copy bootstrap files into /opt/ec
	for (const fileBasename of await readdir(getContainerPath(name))) {
		await spawnPtAsync('lxc', [
			'file', 'push', '--create-dirs',
			Path.join(getContainerPath(name), fileBasename),
			`${name}/opt/ec/`,
		]);
	}

	// Wait for internet
	await spawnPtAsync('lxc', [
		'exec', name, '--',
		'bash', '-c',
		'while ! curl -Ifsm1 google.com >/dev/null; do sleep 0.5; done',
	]);

	// Bootstrap
	await spawnPtAsync('lxc', [
		'exec', name, '--cwd', '/opt/ec', '--',
		'/opt/ec/bootstrap-root.sh',
	]);
	await spawnPtAsync('lxc', [
		'exec', name, '--cwd', '/opt/ec', '--',
		'su', '-l', '-c', '/opt/ec/bootstrap-user.sh', 'ubuntu',
	]);

	// Add EC_INITIAL_DIR to allow smart cwd logins
	await spawnPtAsync('lxc', [
		'exec', name, '--',
		'bash', '-c',
		`echo '\n[[ -n "$EC_INITIAL_DIR" ]] && cd "$EC_INITIAL_DIR"' >> /home/ubuntu/.profile`
	]);

	log();

	const { login } = await prompts({
		type    : 'confirm',
		name    : 'login',
		message : 'Log into container?',
		initial : true,
	});
	if (login) {
		await logIntoContainer(name);
	}
}

async function main ()
{
	const args = parseArgs();

	if (args['--help']) {
		return displayHelp();
	}

	const cmd = args._.find(a => !a.startsWith('-')) ?? 'login';

	switch (cmd) {
		case 'init':
			return await initContainer(args['--container']);

		case 'login':
			return await logIntoContainer(args['--container']);

		case 'provision':
			return await provisionContainer(args['--container']);

		case 'stop':
			return await autoStopContainer(args['--container']);

		default:
			return log(`Unknown command: "${cmd}"`);
	}
}


main().catch(console.error);
