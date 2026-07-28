import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import * as fs from 'fs/promises';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '..', 'data');

interface UserConfig {
    userId: number;
    sourceChannels: number[];
    targetChannels: number[];
    filterKeywords: string[];
    forwardDelay: number; // in seconds
    isRunning: boolean;
}

class ForwardingService {
    private bot: Telegraf<Context>;
    private userConfigs: Map<number, UserConfig> = new Map();

    constructor(bot: Telegraf<Context>) {
        this.bot = bot;
    }

    public async start() {
        await this.loadAllUserConfigs();
        this.bot.on('channel_post', this.handleChannelMessage.bind(this));
    }

    public async addSourceChannel(userId: number, channelId: number, name?: string): Promise<void> {
        const config = await this.getUserConfig(userId);
        if (!config.sourceChannels.includes(channelId)) {
            config.sourceChannels.push(channelId);
            await this.saveUserConfig(userId, config);
        }
    }

    public async removeSourceChannel(userId: number, channelId: number): Promise<void> {
        const config = await this.getUserConfig(userId);
        config.sourceChannels = config.sourceChannels.filter(c => c !== channelId);
        await this.saveUserConfig(userId, config);
    }

    public async addTargetChannel(userId: number, channelId: number, name?: string): Promise<void> {
        const config = await this.getUserConfig(userId);
        if (!config.targetChannels.includes(channelId)) {
            config.targetChannels.push(channelId);
            await this.saveUserConfig(userId, config);
        }
    }

    public async removeTargetChannel(userId: number, channelId: number): Promise<void> {
        const config = await this.getUserConfig(userId);
        config.targetChannels = config.targetChannels.filter(c => c !== channelId);
        await this.saveUserConfig(userId, config);
    }

    public async setFilterKeywords(userId: number, keywords: string[]): Promise<void> {
        const config = await this.getUserConfig(userId);
        config.filterKeywords = keywords;
        await this.saveUserConfig(userId, config);
    }

    public async addFilterKeywords(userId: number, keywords: string[]): Promise<void> {
        const config = await this.getUserConfig(userId);
        config.filterKeywords = [...new Set([...config.filterKeywords, ...keywords])];
        await this.saveUserConfig(userId, config);
    }

    public async removeFilterKeywords(userId: number, keywords: string[]): Promise<void> {
        const config = await this.getUserConfig(userId);
        config.filterKeywords = config.filterKeywords.filter(k => !keywords.includes(k));
        await this.saveUserConfig(userId, config);
    }

    public async setForwardDelay(userId: number, delay: number): Promise<void> {
        const config = await this.getUserConfig(userId);
        config.forwardDelay = delay;
        await this.saveUserConfig(userId, config);
    }

    public async getUserConfig(userId: number): Promise<UserConfig> {
        if (this.userConfigs.has(userId)) {
            return this.userConfigs.get(userId)!;
        }
        const config = await this.loadUserConfig(userId);
        return config || { userId, sourceChannels: [], targetChannels: [], filterKeywords: [], forwardDelay: 0, isRunning: true };
    }

    private async saveUserConfig(userId: number, config: UserConfig): Promise<void> {
        try {
            const filePath = path.join(DATA_DIR, `user_${userId}.json`);
            await fs.writeFile(filePath, JSON.stringify(config, null, 4));
            this.userConfigs.set(userId, config);
        } catch (error) {
            console.error(`Error saving config for user ${userId}:`, error);
        }
    }

    private async loadAllUserConfigs() {
        try {
            const files = await fs.readdir(DATA_DIR);
            for (const file of files) {
                if (file.startsWith('user_') && file.endsWith('.json')) {
                    const userId = parseInt(file.replace('user_', '').replace('.json', ''));
                    if (!isNaN(userId)) {
                        await this.loadUserConfig(userId);
                    }
                }
            }
        } catch (error) {
            console.error('Error loading user configs:', error);
        }
    }

    private async loadUserConfig(userId: number): Promise<UserConfig | undefined> {
        try {
            const filePath = path.join(DATA_DIR, `user_${userId}.json`);
            const data = await fs.readFile(filePath, 'utf-8');
            const config: UserConfig = JSON.parse(data);
            this.userConfigs.set(userId, config);
            return config;
        } catch (error) {
            // If the file doesn't exist, it's not an error, just means no config for this user yet.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error(`Error loading config for user ${userId}:`, error);
            }
            return undefined;
        }
    }

    private async handleChannelMessage(ctx: Context) {
        if (!ctx.channelPost) return;
        const channelId = ctx.channelPost.chat.id;

        for (const [userId, config] of this.userConfigs.entries()) {
            if (config.isRunning && config.sourceChannels.includes(channelId)) {
                // Keyword filtering
                const messageText = 'text' in ctx.channelPost ? ctx.channelPost.text : ('caption' in ctx.channelPost ? ctx.channelPost.caption : '');
                if (config.filterKeywords && config.filterKeywords.length > 0) {
                    if (messageText && config.filterKeywords.some(k => messageText.includes(k))) {
                        console.log(`Skipping message due to keyword filter for user ${userId}`);
                        continue; // Skip this message
                    }
                }

                for (const targetChannel of config.targetChannels) {
                    try {
                        const forwardAction = async () => {
                            await this.bot.telegram.forwardMessage(targetChannel, channelId, ctx.channelPost!.message_id);
                        };

                        if (config.forwardDelay > 0) {
                            setTimeout(forwardAction, config.forwardDelay * 1000);
                        } else {
                            await forwardAction();
                        }
                    } catch (error) {
                        console.error(`Error forwarding message to ${targetChannel}:`, error);
                    }
                }
            }
        }
    }
}

export { ForwardingService };