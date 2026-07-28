import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * 下载文件并保存到本地
 * @param url 文件下载链接
 * @param destPath 本地保存路径
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream'
  });

  const writer = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let error: any = null;
    writer.on('error', err => {
      error = err;
      writer.close();
      reject(err);
    });
    writer.on('close', () => {
      if (!error) {
        resolve();
      }
    });
  });
}


















