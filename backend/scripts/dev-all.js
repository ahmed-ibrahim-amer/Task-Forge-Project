// npm run dev -> starts api + worker + scheduler together, one prefixed log stream
const { spawn } = require('child_process');

const services = ['api', 'worker', 'scheduler'];
const children = services.map((name) => {
    const child = spawn('npm', ['run', `dev:${name}`], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = (stream, out) =>
        stream.on('data', (data) =>
            data.toString().split(/\r?\n/).filter(Boolean).forEach((line) => out.write(`[${name}] ${line}\n`))
        );
    prefix(child.stdout, process.stdout);
    prefix(child.stderr, process.stderr);
    child.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
    return child;
});

const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
