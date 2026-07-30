import 'reflect-metadata';
import http from 'http';
import { buildContainer } from './container';
import { TOKENS } from './tokens';
import { getAppConfig } from './config';
import { initializeExpressApp } from './setup-express';
import { systemInitialization } from './system-setup';
import { SocketServer } from './server/socket.server';
import { ConnectionManager } from './connections/connection-manager.service';
import { McpServerHost } from './mcp/mcp-server';
import { MongoHelper } from './mongo-helper';
import { errorMessage } from './utils/misc.util';

/** Starts the server. */
async function run(): Promise<void> {
    const config = await getAppConfig();
    const container = await buildContainer();

    const app = await initializeExpressApp(container);
    const server = http.createServer(app);

    const socketServer = await container.getAsync<SocketServer>(TOKENS.SocketServer);
    socketServer.registerWithServer(config, server);

    await systemInitialization(container);

    /* Bound to the loopback interface. This application is single-user and must not
       be reachable from the network; this one argument is the most effective control
       in the whole codebase. */
    server.listen(config.serverConfig.port, config.serverConfig.bindAddress, () => {
        console.log(`Mongo Explorer server listening on http://${config.serverConfig.bindAddress}:${config.serverConfig.port}`);

        if (config.mcp.enabled) {
            console.log(`MCP endpoint at http://${config.serverConfig.bindAddress}:${config.serverConfig.port}${config.mcp.path}`);
        }
    });

    registerShutdownHandlers(container, server, socketServer);
}

/** Closes connections cleanly on interrupt or termination. */
function registerShutdownHandlers(
    container: Awaited<ReturnType<typeof buildContainer>>,
    server: http.Server,
    socketServer: SocketServer
): void {
    let isShuttingDown = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (isShuttingDown) {
            return;
        }

        isShuttingDown = true;
        console.log(`\nReceived ${signal}; shutting down.`);

        try {
            await socketServer.close();

            const mcpHost = container.isBound(TOKENS.McpServerHost)
                ? await container.getAsync<McpServerHost>(TOKENS.McpServerHost)
                : undefined;
            await mcpHost?.close();

            const connectionManager = await container.getAsync<ConnectionManager>(TOKENS.ConnectionManager);
            await connectionManager.disconnectAll();

            const helper = await container.getAsync<MongoHelper>(TOKENS.MongoHelper);
            await helper.disconnect();
        } catch (error) {
            console.error(`Error during shutdown: ${errorMessage(error)}`);
        }

        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3_000);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

run().catch(error => {
    console.error(`Failed to start: ${errorMessage(error)}`);
    process.exit(1);
});
