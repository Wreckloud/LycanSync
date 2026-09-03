package com.lycansync.api.system.exception;

/**
 * 系统状态记录不存在异常。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
public class SystemStateNotFoundException extends RuntimeException {

    public SystemStateNotFoundException() {
        super("系统初始化状态记录不存在");
    }
}
