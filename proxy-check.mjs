import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const text = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const start = text.indexOf('  async function proxyApi(req, res) {');
const end = text.indexOf('  return async function handle(req, res)', start);
const factory = new Function('API_FUNCTION_ENDPOINT', 'API_UPSTREAM', 'readBody', 'fetch', text.slice(start, end) + '\nreturn proxyApi;');
async function run(method, url, body, result, cookie) {
  let sent, received;
  const proxy = factory('https://functions.example/?integration=raw', 'https://gateway.example', async () => body,
    async (url, init) => { sent = JSON.parse(init.body); return {ok:true,json:async()=>result}; });
  await proxy({method,url,headers:{host:'fotli.ru',cookie,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}},
    {writeHead:(status,headers)=>{received={status,headers};},end:body=>{received.body=body;}});
  return {sent,received};
}
let r = await run('GET','/api/me?a=1&a=2',Buffer.alloc(0),{statusCode:200,headers:{'Content-Type':'application/json'},body:'{"ok":true}'},'sid=test');
assert.equal(r.sent.httpMethod,'GET');assert.equal(r.sent.path,'/api/me');assert.deepEqual(r.sent.multiValueQueryStringParameters.a,['1','2']);assert.equal(r.sent.headers.cookie,'sid=test');assert.equal(r.received.body.toString(),'{"ok":true}');
r = await run('POST','/api/auth/telegram/bot/start',Buffer.from('{"x":"С‚РµСЃС‚"}'),{statusCode:302,headers:{location:'https://oauth.yandex.ru','content-length':'999'},multiValueHeaders:{'Set-Cookie':['a=1; HttpOnly','b=2; Secure']},cookies:['c=3'],body:''});
assert.equal(Buffer.from(r.sent.body,'base64').toString(),'{"x":"С‚РµСЃС‚"}');assert.equal(r.received.status,302);assert.equal(r.received.headers.location,'https://oauth.yandex.ru');assert.deepEqual(r.received.headers['set-cookie'],['a=1; HttpOnly','b=2; Secure','c=3']);assert.equal(r.received.headers['content-length'],undefined);
r = await run('HEAD','/api/result',Buffer.alloc(0),{statusCode:200,body:Buffer.from([0,255,13]).toString('base64'),isBase64Encoded:true});assert.equal(r.received.body,undefined);
r = await run('GET','/api/result',Buffer.alloc(0),{statusCode:200,body:Buffer.from([0,255,13]).toString('base64'),isBase64Encoded:true});assert.deepEqual(r.received.body,Buffer.from([0,255,13]));
console.log('PASS: query, cookie forwarding, POST body, redirects, session cookies, HEAD, binary response');
