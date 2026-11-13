package com.lycansync.api.auth.mapper;

import com.lycansync.api.auth.model.QqConfiguration;
import org.apache.ibatis.annotations.Mapper;

/**
 * 服务器 QQ 登录配置持久化。
 *
 * @author Wreckloud
 * @since 2026-11-13
 */
@Mapper
public interface QqConfigurationMapper {
    QqConfiguration find();
    int save(QqConfiguration configuration);
}
