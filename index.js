require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');
const jalaali = require('jalaali-js');
const ics = require('ics');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ALLOWED_CHAT_ID = Number(process.env.ALLOWED_CHAT_ID);

// موقتاً اطلاعات آخرین تسک دریافتی کاربر را نگه می‌داریم تا بعد از زدن دکمه تایید استفاده شود
let pendingTask = null;

// میدل‌ور امنیتی
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.from.id === ALLOWED_CHAT_ID) {
    return next();
  }
});

bot.start((ctx) => ctx.reply('سلام! دستیار شما آنلاین است. تسکت رو برام بفرست.'));

// دریافت پیام و تحلیل با جمنای
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const loadingMsg = await ctx.reply('⏳ در حال تحلیل پیام...');

  try {
    const today = new Date();
    const days = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه', 'شنبه'];
    const dayName = days[today.getDay()];
    const todayJalaali = jalaali.toJalaali(today);
    const todayStr = `${todayJalaali.jy}/${todayJalaali.jm}/${todayJalaali.jd}`;

    const prompt = `
    تو یک دستیار استخراج اطلاعات تقویم هستی.
    امروز: ${dayName}، تاریخ شمسی: ${todayStr}
    پیام کاربر: "${userMessage}"

    اطلاعات را استخراج کن و فقط و فقط یک خروجی JSON با فرمت زیر بده (بدون هیچ متن اضافه‌ای، بدون مارک‌داون):
    {
      "title": "عنوان خلاصه تسک",
      "date_gregorian": "YYYY-MM-DD", 
      "date_jalali": "YYYY/MM/DD",
      "time": "HH:mm" (اگر ساعتی در پیام نبود null بگذار),
      "remind_days_before": 1,
      "needs_clarification": false
    }
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const jsonString = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
    const taskData = JSON.parse(jsonString);

    if (taskData.needs_clarification) {
       return ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, '🤔 متوجه تاریخ دقیق نشدم. میشه واضح‌تر بگی چه روزی؟');
    }

    // ذخیره موقت تسک برای این کاربر
    pendingTask = taskData;

    const confirmText = `📌 **تسک:** ${taskData.title}\n📅 **تاریخ شمسی:** ${taskData.date_jalali}\n🗓 **تاریخ میلادی:** ${taskData.date_gregorian}\n⏰ **ساعت:** ${taskData.time || 'نامشخص'}\n\nآیا این اطلاعات رو تایید می‌کنی؟`;

    await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, confirmText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ بله، ساخت فایل تقویم', `confirm`)],
        [Markup.button.callback('❌ لغو', 'cancel')]
      ])
    });

  } catch (error) {
    console.error('Gemini Error:', error);
    ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, '⚠️ خطا در تحلیل پیام. لطفاً دوباره امتحان کن.');
  }
});

bot.action('cancel', (ctx) => {
  pendingTask = null;
  ctx.editMessageText('❌ لغو شد.');
});

// تایید نهایی و ساخت فایل تقویم آیفون (.ics)
bot.action('confirm', async (ctx) => {
  if (!pendingTask) {
    return ctx.editMessageText('⚠️ اطلاعات تسک منقضی شده است. لطفاً دوباره پیام بفرستید.');
  }

  try {
    const [year, month, day] = pendingTask.date_gregorian.split('-').map(Number);
    let hours = 9;
    let minutes = 0;

    if (pendingTask.time) {
      const [h, m] = pendingTask.time.split(':').map(Number);
      hours = h;
      minutes = m;
    }

    const event = {
      start: [year, month, day, hours, minutes],
      duration: { hours: 1 },
      title: pendingTask.title,
      description: 'ثبت شده توسط بات تلگرام شخصی',
      status: 'CONFIRMED',
      busyStatus: 'BUSY',
      alarms: [
        { action: 'display', description: 'یادآوری تسک', trigger: { hours: 24 * (pendingTask.remind_days_before || 1), before: true } }
      ]
    };

    ics.createEvent(event, async (error, value) => {
      if (error) {
        console.error(error);
        return ctx.reply('⚠️ خطا در ساخت فایل تقویم.');
      }

      const filePath = path.join(__dirname, 'event.ics');
      fs.writeFileSync(filePath, value);

      await ctx.editMessageText(`✅ **تسک با موفقیت نهایی شد!**\nفایل تقویم زیر را لمس کنید تا به تقویم آیفون اضافه شود:`, { parse_mode: 'Markdown' });
      await ctx.replyWithDocument({ source: filePath, filename: `${pendingTask.title}.ics` });
      
      pendingTask = null;
    });

  } catch (err) {
    console.error(err);
    ctx.reply('⚠️ خطایی در فرآیند ذخیره‌سازی رخ داد.');
  }
});

bot.launch().then(() => console.log('🚀 بات روی سرور روشن شد!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));