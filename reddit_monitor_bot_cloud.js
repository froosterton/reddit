const { Builder, By, until } = require('selenium-webdriver');
const { Options } = require('selenium-webdriver/chrome');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

class RedditMonitorBot {
    constructor() {
        this.driver = null;
        this.discordWebhook = process.env.DISCORD_WEBHOOK || 'https://discord.com/api/webhooks/1428552954985713796/5-iGpgsGe2JQROFc87Zdw_i8ImmNnNmg2Kgt7WigJJKwZZeP-ucZ5kceEid5iyo7188U';
        this.lastProcessedPost = null;
        this.isCloudEnvironment = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
    }

    async initialize() {
        console.log('Initializing Reddit Monitor Bot...');
        console.log('Environment:', this.isCloudEnvironment ? 'Cloud' : 'Local');
        
        // Set up Chrome options for cloud deployment
        const chromeOptions = new Options();
        
        if (this.isCloudEnvironment) {
            // Cloud-specific settings
            chromeOptions.addArguments('--headless');
            chromeOptions.addArguments('--no-sandbox');
            chromeOptions.addArguments('--disable-dev-shm-usage');
            chromeOptions.addArguments('--disable-gpu');
            chromeOptions.addArguments('--disable-web-security');
            chromeOptions.addArguments('--disable-features=VizDisplayCompositor');
            chromeOptions.addArguments('--window-size=1920,1080');
            chromeOptions.addArguments('--disable-extensions');
            chromeOptions.addArguments('--disable-plugins');
            chromeOptions.addArguments('--disable-images');
            chromeOptions.addArguments('--disable-javascript');
            chromeOptions.addArguments('--disable-css');
        } else {
            // Local development settings
            chromeOptions.addArguments('--no-sandbox');
            chromeOptions.addArguments('--disable-dev-shm-usage');
            chromeOptions.addArguments('--disable-blink-features=AutomationControlled');
            chromeOptions.addArguments('--disable-web-security');
            chromeOptions.addArguments('--disable-features=VizDisplayCompositor');
        }
        
        chromeOptions.excludeSwitches('enable-automation');
        chromeOptions.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        this.driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(chromeOptions)
            .build();
        
        console.log('Chrome driver initialized');
    }

    async navigateToSubreddit(subreddit) {
        console.log('Navigating to r/' + subreddit + '...');
        const url = 'https://www.reddit.com/r/' + subreddit + '/new/';
        await this.driver.get(url);
        
        // Wait for page to load
        await this.driver.wait(until.elementsLocated(By.css('body')), 10000);
        console.log('Page loaded successfully (NEW posts)');
    }

    async checkForRecaptcha() {
        try {
            const recaptchaElements = await this.driver.findElements(By.css('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]'));
            if (recaptchaElements.length > 0) {
                console.log('⚠️ reCAPTCHA challenge detected!');
                return true;
            }
            
            const pageText = await this.driver.getPageSource();
            if (pageText.includes('Prove your humanity') || pageText.includes('I\'m not a robot')) {
                console.log('⚠️ reCAPTCHA challenge detected via text!');
                return true;
            }
            
            return false;
        } catch (error) {
            console.log('Error checking for reCAPTCHA:', error.message);
            return false;
        }
    }

    async handleRecaptcha() {
        console.log('🔄 Handling reCAPTCHA challenge...');
        
        try {
            await this.driver.sleep(3000);
            
            const checkbox = await this.driver.findElement(By.css('input[type="checkbox"], .g-recaptcha'));
            await checkbox.click();
            console.log('✓ Clicked reCAPTCHA checkbox');
            
            await this.driver.sleep(5000);
            
            const stillOnRecaptcha = await this.checkForRecaptcha();
            if (stillOnRecaptcha) {
                console.log('⚠️ Still on reCAPTCHA page, reloading...');
                await this.driver.navigate().refresh();
                await this.driver.sleep(5000);
            }
            
        } catch (error) {
            console.log('Could not handle reCAPTCHA automatically, reloading page...');
            await this.driver.navigate().refresh();
            await this.driver.sleep(5000);
        }
    }

    isTradingImage(imageSrc) {
        const excludePatterns = [
            'avatar_default',
            'profileIcon',
            'redditstatic.com/avatars',
        ];
        
        return !excludePatterns.some(pattern => imageSrc.includes(pattern));
    }

    isTradingRelated(postText) {
        const tradingKeywords = [
            'selling', 'trading', 'buying', 'selling my', 'trading my', 'sell my',
            'trade my', 'buy my', 'offering', 'looking for', 'want to trade',
            'haven\'t played', 'haven\'t been on', 'old account', 'inventory',
            'how much is', 'what is worth', 'worth', 'value', 'price',
            'limited', 'limiteds', 'rare', 'valuable', 'expensive',
            'headless', 'dominus', 'sparkle time', 'clockwork', 'korblox',
            'crown', 'crown of thorns', 'shaggy', 'valkyrie', 'golden',
            'black iron', 'commando', 'headphones', 'fedora', 'top hat',
            'w/l', 'wfl', 'win/lose', 'good trade', 'bad trade',
            'twin kodachi', 'sword of darkness', 'advice on selling',
            'old items', '13 years ago', 'email offering', 'safest way',
            'sold old roblox items', 'high value', 'valuable items',
            'need advice', 'selling my', 'old roblox items', 'transactions',
            'safest way to handle', 'don\'t get scammed', 'old gear',
            'gear from', 'reached out', 'email', 'offer', '600', 'dollars'
        ];
        
        const lowerText = postText.toLowerCase();
        return tradingKeywords.some(keyword => lowerText.includes(keyword));
    }

    hasLowValue(postText) {
        const valuePatterns = [
            /(\d+[kK])\s*(?:robux|r$)/g,
            /(\d+)\s*(?:robux|r$)/g,
            /(\d+[kK])\s*(?:value|worth)/g,
            /(\d+)\s*(?:value|worth)/g
        ];
        
        for (const pattern of valuePatterns) {
            const matches = postText.match(pattern);
            if (matches) {
                for (const match of matches) {
                    const number = parseInt(match.replace(/[kK]/, '000').replace(/[^\d]/g, ''));
                    if (number < 100000) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    shouldSendPost(postText, hasImage, imageSrc) {
        console.log('\\n=== POST CONTENT ANALYSIS ===');
        console.log('Post text: ' + postText.substring(0, 200) + (postText.length > 200 ? '...' : ''));
        console.log('Has image: ' + hasImage);
        console.log('Image source: ' + imageSrc);
        
        if (hasImage && !this.isTradingImage(imageSrc)) {
            console.log('✗ Image is profile picture/avatar - filtering out');
            return false;
        }
        
        if (this.isTradingRelated(postText)) {
            console.log('✓ Post contains trading keywords');
            
            if (postText.toLowerCase().includes('twin kodachi') || 
                postText.toLowerCase().includes('sword of darkness') ||
                postText.toLowerCase().includes('13 years ago') ||
                postText.toLowerCase().includes('email offering') ||
                postText.toLowerCase().includes('600') ||
                postText.toLowerCase().includes('dollars') ||
                postText.toLowerCase().includes('old items') ||
                postText.toLowerCase().includes('gear from')) {
                console.log('✓ Post mentions high-value items or old items - sending');
                return true;
            }
            
            if (this.hasLowValue(postText)) {
                console.log('✗ Post mentions low values under 100k - filtering out');
                return false;
            }
            
            console.log('✓ Post is trading-related and passes filters - sending');
            return true;
        }
        
        if (hasImage && this.isTradingImage(imageSrc)) {
            console.log('✓ Post has trading image - sending');
            return true;
        }
        
        console.log('✗ Post is not trading-related and has no trading image - filtering out');
        return false;
    }

    async checkTopPost() {
        console.log('\\n=== CHECKING TOP POST ===');
        
        try {
            const hasRecaptcha = await this.checkForRecaptcha();
            if (hasRecaptcha) {
                console.log('⚠️ reCAPTCHA detected, handling...');
                await this.handleRecaptcha();
            }
            
            const selectors = [
                '[data-testid="post-container"]',
                '[data-click-id="body"]',
                '.Post',
                'article'
            ];
            
            let posts = [];
            for (const selector of selectors) {
                try {
                    await this.driver.wait(until.elementsLocated(By.css(selector)), 5000);
                    posts = await this.driver.findElements(By.css(selector));
                    if (posts.length > 0) break;
                } catch (e) {
                    continue;
                }
            }
            
            console.log('Found ' + posts.length + ' posts on page');
            
            if (posts.length === 0) {
                console.log('⚠️ No posts found, checking for reCAPTCHA...');
                const stillHasRecaptcha = await this.checkForRecaptcha();
                if (stillHasRecaptcha) {
                    console.log('⚠️ Still on reCAPTCHA page, reloading...');
                    await this.driver.navigate().refresh();
                    await this.driver.sleep(5000);
                    return null;
                }
            }
            
            if (posts.length === 0) {
                console.log('No posts found to check');
                return null;
            }
            
            const topPost = posts[0];
            console.log('\\n--- Checking TOP POST ---');
            
            try {
                let postUrl = '';
                try {
                    const linkElement = await topPost.findElement(By.css('a[href*="/comments/"]'));
                    postUrl = await linkElement.getAttribute('href');
                    if (!postUrl.startsWith('http')) {
                        postUrl = 'https://www.reddit.com' + postUrl;
                    }
                } catch (e) {
                    console.log('Could not get post URL');
                }
                
                if (postUrl && this.lastProcessedPost === postUrl) {
                    console.log('⏭️ Same post as last check - skipping');
                    return null;
                }
                
                let postText = '';
                try {
                    const textBodySelectors = [
                        'shreddit-post-text-body',
                        '[slot="text-body"]',
                        '.feed-card-text-preview',
                        '.md'
                    ];
                    
                    for (const selector of textBodySelectors) {
                        try {
                            const textElement = await topPost.findElement(By.css(selector));
                            postText = await textElement.getText();
                            if (postText.trim()) {
                                console.log('Found post text from ' + selector + ': ' + postText.substring(0, 100) + '...');
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                    
                    if (!postText.trim()) {
                        const titleSelectors = [
                            'h3[data-testid="post-title"]',
                            'h3',
                            '[data-testid="post-title"]',
                            'h2',
                            'a[data-click-id="body"]'
                        ];
                        
                        for (const selector of titleSelectors) {
                            try {
                                const titleElement = await topPost.findElement(By.css(selector));
                                postText = await titleElement.getText();
                                if (postText.trim()) {
                                    console.log('Found post title: ' + postText);
                                    break;
                                }
                            } catch (e) {
                                continue;
                            }
                        }
                    }
                    
                    if (!postText.trim()) {
                        try {
                            const textElement = await topPost.findElement(By.css('[data-click-id="body"]'));
                            postText = await textElement.getText();
                            if (postText.trim()) {
                                console.log('Found post text: ' + postText);
                            }
                        } catch (e) {
                            console.log('Could not get post text');
                        }
                    }
                } catch (e) {
                    console.log('Could not get post text');
                }
                
                const imageSelectors = [
                    'img[src*="preview.redd.it"]',
                    'img[src*="i.redd.it"]',
                    'img[src*="external-preview"]'
                ];
                
                let hasImage = false;
                let imageElements = [];
                let imageSrc = '';
                
                for (const selector of imageSelectors) {
                    try {
                        imageElements = await topPost.findElements(By.css(selector));
                        if (imageElements.length > 0) {
                            hasImage = true;
                            imageSrc = await imageElements[0].getAttribute('src');
                            console.log('Found post image: ' + imageSrc);
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
                
                if (this.shouldSendPost(postText, hasImage, imageSrc)) {
                    console.log('✓ Top post is relevant - processing');
                    
                    if (postUrl) {
                        this.lastProcessedPost = postUrl;
                    }
                    
                    return {
                        post: topPost,
                        title: postText.substring(0, 100),
                        postUrl: postUrl,
                        imageElements: imageElements,
                        hasImage: hasImage,
                        fullText: postText,
                        imageSrc: imageSrc
                    };
                } else {
                    console.log('✗ Top post filtered out');
                    if (postUrl) {
                        this.lastProcessedPost = postUrl;
                    }
                    return null;
                }
                
            } catch (error) {
                console.log('Error checking top post: ' + error.message);
                return null;
            }
            
        } catch (error) {
            console.error('Error checking top post:', error);
            return null;
        }
    }

    async extractTextFromImages(imageElements) {
        console.log('Extracting text from images...');
        const allText = [];
        
        for (let i = 0; i < imageElements.length; i++) {
            try {
                console.log('Processing image ' + (i + 1) + '/' + imageElements.length + '...');
                
                const imageSrc = await imageElements[i].getAttribute('src');
                console.log('Image source: ' + imageSrc);
                
                let imagePath = '';
                
                try {
                    console.log('Attempting to download image directly...');
                    const response = await axios.get(imageSrc, { 
                        responseType: 'arraybuffer',
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        }
                    });
                    
                    imagePath = 'temp_image_' + i + '.png';
                    fs.writeFileSync(imagePath, response.data);
                    console.log('✓ Downloaded image directly');
                    
                } catch (downloadError) {
                    console.log('Direct download failed, using screenshot method...');
                    
                    try {
                        await this.driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", imageElements[i]);
                        await this.driver.sleep(1000);
                        
                        const screenshot = await imageElements[i].takeScreenshot();
                        imagePath = 'temp_image_' + i + '.png';
                        fs.writeFileSync(imagePath, screenshot, 'base64');
                        console.log('✓ Captured image via screenshot');
                        
                    } catch (screenshotError) {
                        console.log('Screenshot method also failed, trying full page screenshot...');
                        
                        const fullScreenshot = await this.driver.takeScreenshot();
                        const fullImagePath = 'temp_full_' + i + '.png';
                        fs.writeFileSync(fullImagePath, fullScreenshot, 'base64');
                        
                        imagePath = fullImagePath;
                        console.log('✓ Using full page screenshot');
                    }
                }
                
                if (!imagePath || !fs.existsSync(imagePath)) {
                    console.log('✗ Could not capture image ' + (i + 1));
                    continue;
                }
                
                console.log('Running OCR on image ' + (i + 1) + '...');
                
                const { data: { text } } = await Tesseract.recognize(imagePath, 'eng', {
                    logger: m => {
                        if (m.status === 'loading tesseract core' && m.progress === 1) {
                            console.log('OCR: Tesseract loaded');
                        } else if (m.status === 'initialized tesseract' && m.progress === 1) {
                            console.log('OCR: Tesseract initialized');
                        } else if (m.status === 'loaded language traineddata' && m.progress === 1) {
                            console.log('OCR: Language data loaded');
                        } else if (m.status === 'recognizing text' && m.progress === 1) {
                            console.log('OCR: Text recognition complete');
                        }
                    },
                    tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,:()[]{}@#$%^&*+=<>?/|\\~`"\'',
                    tessedit_pageseg_mode: '6',
                    tessedit_ocr_engine_mode: '3',
                    preserve_interword_spaces: '1',
                    classify_bln_numeric_mode: '1',
                    textord_min_linesize: '2.5'
                });
                
                if (text.trim()) {
                    console.log('Extracted text from image ' + (i + 1) + ':');
                    console.log(text);
                    
                    if (!this.isCloudEnvironment) {
                        const debugPath = 'ocr_debug_' + i + '.txt';
                        fs.writeFileSync(debugPath, `Image Source: ${imageSrc}\\n\\nOCR Result:\\n${text}`);
                        console.log('OCR result saved to: ' + debugPath);
                    }
                    
                    allText.push({
                        imageIndex: i + 1,
                        imageSrc: imageSrc,
                        text: text.trim()
                    });
                } else {
                    console.log('No text found in image ' + (i + 1));
                }
                
                if (fs.existsSync(imagePath)) {
                    fs.unlinkSync(imagePath);
                }
                if (fs.existsSync('temp_full_' + i + '.png')) {
                    fs.unlinkSync('temp_full_' + i + '.png');
                }
                
            } catch (error) {
                console.error('Error processing image ' + (i + 1) + ':', error);
            }
        }
        
        return allText;
    }

    parseTradeValue(ocrText) {
        console.log('\\n=== PARSING TRADE VALUE ===');
        console.log('OCR Text to analyze: ' + ocrText.substring(0, 200) + '...');
        
        const valuePatterns = [
            /Total Value[:\s]*[O©]\s*(\d+(?:,\d+)?)/gi,
            /Total Value[:\s]*(\d+(?:,\d+)?)/gi,
            /Total Value[:\s]*[O©]\s*(\d+)/gi,
            /Total Value[:\s]*(\d+)/gi,
            /Trade Value[:\s]*[O©]\s*(\d+(?:,\d+)?)/gi,
            /Trade Value[:\s]*(\d+(?:,\d+)?)/gi,
            /(\d{4,}(?:,\d{3})*)/g,
            /(\d{5,})/g,
            /[O©]\s*(\d+(?:,\d+)?)/gi,
            /(\d+(?:,\d+)?)\s*[O©]/gi,
        ];
        
        let maxValue = 0;
        let foundValues = [];
        let allMatches = [];
        
        for (const pattern of valuePatterns) {
            const matches = ocrText.match(pattern);
            if (matches) {
                for (const match of matches) {
                    allMatches.push(match);
                    console.log('Found potential value match: "' + match + '"');
                    
                    const numberMatch = match.match(/(\d+(?:,\d+)?)/);
                    if (numberMatch) {
                        let value = parseFloat(numberMatch[1].replace(/,/g, ''));
                        foundValues.push(value);
                        if (value > maxValue) {
                            maxValue = value;
                        }
                        console.log('✓ Extracted value: ' + value);
                    }
                }
            }
        }
        
        console.log('All matches found: ' + allMatches.join(', '));
        console.log('All values found: ' + foundValues.join(', '));
        
        if (maxValue > 0) {
            console.log('✓ Using highest value found: ' + maxValue);
            return maxValue;
        }
        
        console.log('✗ Could not parse trade value from OCR text');
        if (!this.isCloudEnvironment) {
            console.log('Full OCR text for debugging:');
            console.log(ocrText);
        }
        return null;
    }

    hasLowValueInImage(ocrText) {
        const values = this.parseTradeValue(ocrText);
        
        if (values === null) {
            console.log('✗ Could not determine trade value - filtering out to be safe');
            return true;
        }
        
        if (values < 100000) {
            console.log('✗ Image contains low values under 100k: ' + values);
            return true;
        }
        
        return false;
    }

    async sendToDiscord(textData, postTitle, postUrl, hasImage) {
        console.log('\\n=== SENDING TO DISCORD ===');
        
        try {
            let bestImage = null;
            let tradeValue = null;
            
            if (hasImage && textData.length > 0) {
                for (const item of textData) {
                    if (item.text.toLowerCase().includes('total value') || 
                        item.text.toLowerCase().includes('items you') ||
                        item.text.toLowerCase().includes('robux')) {
                        bestImage = item;
                        tradeValue = this.parseTradeValue(item.text);
                        break;
                    }
                }
                
                if (!bestImage && textData.length > 0) {
                    bestImage = textData[0];
                    tradeValue = this.parseTradeValue(bestImage.text);
                }
            }
            
            const embed = {
                title: 'Post',
                url: postUrl || 'https://www.reddit.com/r/RobloxTrading',
                color: 0x00ff00,
                fields: [],
                footer: {
                    text: 'Reddit Monitor Bot',
                    icon_url: 'https://cdn.discordapp.com/emojis/1234567890123456789.png'
                },
                timestamp: new Date().toISOString()
            };
            
            embed.description = postTitle.substring(0, 200) + (postTitle.length > 200 ? '...' : '');
            
            if (tradeValue) {
                embed.fields.push({
                    name: 'Trade Value',
                    value: 'Trade worth ~' + tradeValue.toLocaleString() + ' Value',
                    inline: true
                });
            }
            
            embed.fields.push({
                name: 'Subreddit',
                value: 'r/RobloxTrading',
                inline: true
            });
            
            if (bestImage) {
                embed.image = {
                    url: bestImage.imageSrc
                };
            }
            
            const response = await axios.post(this.discordWebhook, {
                embeds: [embed]
            });
            
            console.log('✓ Successfully sent embed to Discord!');
            console.log('Response status: ' + response.status);
            
        } catch (error) {
            console.error('Error sending to Discord:', error);
            throw error;
        }
    }

    async processTopPost(topPost) {
        if (!topPost) {
            console.log('No relevant top post to process');
            return;
        }
        
        console.log('\\n=== PROCESSING TOP POST ===');
        console.log('Title: ' + topPost.title);
        
        let textData = [];
        let shouldSend = true;
        
        if (topPost.hasImage && topPost.imageElements.length > 0) {
            textData = await this.extractTextFromImages(topPost.imageElements);
            
            for (const item of textData) {
                console.log('\\n=== CHECKING IMAGE VALUES ===');
                console.log('Image ' + item.imageIndex + ' text: ' + item.text.substring(0, 100) + '...');
                
                const hasLowValue = this.hasLowValueInImage(item.text);
                console.log('Has low value result: ' + hasLowValue);
                
                if (hasLowValue) {
                    console.log('✗ Post has low values in image - filtering out');
                    shouldSend = false;
                    break;
                } else {
                    console.log('✓ Image values are acceptable (100k+)');
                }
            }
        }
        
        if (shouldSend) {
            await this.sendToDiscord(textData, topPost.fullText, topPost.postUrl, topPost.hasImage);
        } else {
            console.log('✗ Post filtered out due to low values');
        }
    }

    async runContinuous() {
        try {
            await this.initialize();
            await this.navigateToSubreddit('RobloxTrading');
            
            console.log('\\n🔄 Starting continuous monitoring...');
            console.log('Bot will refresh every 3 minutes and check the TOP POST only');
            console.log('Press Ctrl+C to stop the bot');
            
            let cycleCount = 0;
            
            while (true) {
                cycleCount++;
                console.log('\\n' + '='.repeat(50));
                console.log('🔄 CYCLE ' + cycleCount + ' - ' + new Date().toLocaleTimeString());
                console.log('='.repeat(50));
                
                try {
                    console.log('🔄 Refreshing page to get new posts...');
                    await this.driver.navigate().refresh();
                    await this.driver.sleep(3000);
                    
                    const topPost = await this.checkTopPost();
                    await this.processTopPost(topPost);
                    
                    console.log('\\n✅ Cycle ' + cycleCount + ' completed');
                    console.log('⏰ Waiting 3 minutes before next cycle...');
                    
                    await this.driver.sleep(180000);
                    
                } catch (error) {
                    console.error('❌ Error in cycle ' + cycleCount + ':', error);
                    console.log('🔄 Continuing with next cycle in 3 minutes...');
                    await this.driver.sleep(180000);
                }
            }
            
        } catch (error) {
            console.error('❌ Bot error:', error);
        } finally {
            if (this.driver) {
                console.log('\\n🛑 Closing browser...');
                await this.driver.quit();
            }
        }
    }
}

// Run the bot in continuous mode
const bot = new RedditMonitorBot();
bot.runContinuous().catch(console.error);
