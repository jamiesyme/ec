#!/usr/bin/env node

import arg             from 'arg';
import { spawn }       from 'child_process';
import { stripIndent } from 'common-tags';
import { readFile }    from 'fs/promises';
import { Agent }       from 'http';
import fetch           from 'node-fetch';
import { homedir }     from 'os';
import Path            from 'path';
import { cwd }         from 'process';
import Toml            from 'toml';


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


function log (str)
{
	console.log(stripIndent(str));
}

function parseArgs ()
{
	return arg({
		'--help' : Boolean,
		'-h'     : '--help',
	});
}

async function loadMap ()
{
	const configDir = Path.join(
		process.env.XDG_CONFIG_HOME ?? Path.join(homedir(), '.config'),
		'ec',
	);

	const dirMapPath = Path.join(configDir, 'map.toml');
	const dirMapStr = await readFile(dirMapPath, 'utf-8');
	const dirMap = Toml.parse(dirMapStr);

	return dirMap;
}

function findContainerByDir (map, startPath)
{
	let currentPath = startPath;

	while (true) {
		for (const container in map) {
			if (map[container] === currentPath) {
				return container;
			}
		}

		if (currentPath === '/') {
			return null;
		}

		currentPath = Path.dirname(currentPath);
	}
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

async function autoStartContainer (name)
{
	const status = await getContainerStatus(name);
	if (status === 'running') {
		return;
	}

	await startContainer(name);
}

async function logIntoContainer (name)
{
	const process = spawn(
		'lxc',
		['exec', name, '--', 'sudo', '--login', '--user', 'ubuntu'],
		{ stdio : 'inherit' },
	);

	await new Promise((resolve, reject) => {
		process.on('exit', resolve);
		process.on('error', reject);
	});
}

async function main ()
{
	const args = parseArgs();

	if (args['--help']) {
		return log(`
Description:
  Logs into an LXC instance.

  If the container name is omitted, it will be guessed using the current working
  directory (see ~/.config/ec/dir-map.toml).

  If the container is not running, it will be auto-started.

Usage: ec <container> [options]

Options:
  -h, --help   display this help and exit
		`);
	}

	let containerName = args._.find(a => !a.startsWith('-'));

	if (!containerName) {
		containerName = findContainerByDir(await loadMap(), cwd());
	}

	if (!containerName) {
		return log(`
			No container found within current directory.
		`);
	}

	await autoStartContainer(containerName);
	await logIntoContainer(containerName);
}


main().catch(console.error);
