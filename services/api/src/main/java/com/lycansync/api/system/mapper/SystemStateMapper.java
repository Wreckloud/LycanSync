package com.lycansync.api.system.mapper;

import org.apache.ibatis.annotations.Mapper;

import java.util.Optional;

/**
 * 系统状态数据访问。
 *
 * @author Wreckloud
 * @since 2026-09-03
 */
@Mapper
public interface SystemStateMapper {

    // empty 表示状态行不存在；只有 Optional.of(false) 才表示尚未初始化。
    Optional<Boolean> findInitialized();
}
