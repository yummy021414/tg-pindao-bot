/**
 * 相册数据验证器
 */
export class AlbumDataValidator {
  static validate(albumData: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // 基础字段检查
    if (!albumData.id) errors.push('缺少相册ID');
    if (!albumData.userId) errors.push('缺少用户ID');
    if (!albumData.name) errors.push('缺少相册名称');
    if (!albumData.createdAt) errors.push('缺少创建时间');
    
    // 组数据检查
    if (!albumData.groups || !Array.isArray(albumData.groups)) {
      errors.push('相册组数据缺失或格式错误');
      return { valid: false, errors };
    }
    
    if (albumData.groups.length === 0) {
      errors.push('相册没有任何组');
    }
    
    // 逐组验证
    albumData.groups.forEach((group: any, i: number) => {
      if (!group.id) errors.push(`第${i+1}组缺少ID`);
      if (!group.files || !Array.isArray(group.files)) {
        errors.push(`第${i+1}组文件数据缺失`);
        return;
      }
      
      if (group.files.length === 0) {
        errors.push(`第${i+1}组没有任何文件`);
      }
      
      // 逐文件验证
      group.files.forEach((file: any, j: number) => {
        if (!file.id) errors.push(`第${i+1}组第${j+1}个文件缺少ID`);
        if (!file.type) errors.push(`第${i+1}组第${j+1}个文件缺少类型标记`);
        if (file.type !== 'photo' && file.type !== 'video') {
          errors.push(`第${i+1}组第${j+1}个文件类型无效: ${file.type}`);
        }
      });
    });
    
    return { valid: errors.length === 0, errors };
  }
}
















