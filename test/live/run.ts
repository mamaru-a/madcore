/**
 * Live E2E orchestrator — runs modular suites against madmail.
 *
 *   SERVER_URL=http://127.0.0.1:8080 bun run test:live-full
 *   SERVER_URL=https://… JOIN_URI='https://i.delta.chat/#…' bun run test:live-full
 */
import {
    parseLiveEnv,
    summaryAndExit,
    tryMethod,
} from './harness';
import { resolvePeerSetup } from './setup';
import { runQrHelpers, runSecureJoinExtras } from './securejoin';
import { runProfileSuite } from './profile';
import { runMessagingSuite } from './messaging';
import { runMessagingReceiveSuite } from './messaging-receive';
import { runWsSuite } from './ws';
import { runJoinGroupSuite, runIncomingCallSuite } from './two-party-extras';
import { runWebxdcSuite, runLocationSuite, runCallsSuite } from './webxdc-location-calls';
import { runGroupsSuite } from './groups';
import { runStoreChatSuite } from './store-chat';
import { runConfigBackupSuite } from './config-backup';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function main() {
    const { server, joinUri, joinTimeoutMs } = parseLiveEnv();

    console.log('\n🚀 Full live E2E against madmail (modular suites)');
    console.log(`   Server: ${server}`);
    console.log(`   Mode:   ${joinUri ? `external peer ${joinUri.slice(0, 56)}…` : 'local Alice↔Bob'}\n`);

    const setup = await resolvePeerSetup(server, joinUri, joinTimeoutMs);
    if (!setup) {
        summaryAndExit();
        return;
    }
    const { dc, account: a, accountB: b, contact, contactId, peerEmail, joinUri: uri, mode } = setup;
    const aEmail = a.getCredentials().email;

    console.log('\n── Profile ──');
    await runProfileSuite(a, contact, peerEmail);

    console.log('\n── Messaging ──');
    await runMessagingSuite(a, contact);

    if (mode === 'local' && b) {
        console.log('\n── Messaging receive (peer assertions) ──');
        await runMessagingReceiveSuite(a, b, aEmail, peerEmail, contact);
    }

    console.log('\n── WebIMAP WebSocket depth ──');
    await runWsSuite(a, 'live');

    console.log('\n── Webxdc / location / calls ──');
    await runWebxdcSuite(a, contact, peerEmail);
    await runLocationSuite(a, peerEmail);
    await runCallsSuite(a, contact);

    if (mode === 'local' && b) {
        console.log('\n── joinGroup + acceptIncomingCall ──');
        await runJoinGroupSuite(a, b);
        await runIncomingCallSuite(a, b, contact);
    }

    console.log('\n── Groups / channels ──');
    await runGroupsSuite(a, b, peerEmail, joinTimeoutMs);

    console.log('\n── Store / chat / contacts ──');
    await runStoreChatSuite(a, peerEmail, contactId);

    console.log('\n── QR helpers ──');
    await runQrHelpers(a, uri);

    console.log('\n── Config / backup / relays ──');
    await runConfigBackupSuite(a, server);

    console.log('\n── SecureJoin extras ──');
    await runSecureJoinExtras(a, peerEmail);

    console.log('\n── Teardown ──');
    await tryMethod('disconnect', () => { a.disconnect(); });
    if (b) await tryMethod('B.disconnect', () => { b.disconnect(); });

    await tryMethod('dc.listAccounts', () => `${dc.listAccounts().length}`);
    await tryMethod('dc.findAccountByEmail', () =>
        dc.findAccountByEmail(a.getCredentials().email)?.id);
    await tryMethod('dc.getAccount', () => dc.getAccount(a.id).id);

    summaryAndExit();
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
