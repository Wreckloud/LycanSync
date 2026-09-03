package com.lycansync.api.system.service;

import com.lycansync.api.system.dto.SystemInitializationStatusResponse;
import com.lycansync.api.system.exception.SystemStateNotFoundException;
import com.lycansync.api.system.mapper.SystemStateMapper;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 系统初始化状态服务测试。
 *
 * @author Wreckloud
 * @since 2026-09-02
 */
class SystemInitializationServiceTests {

    private final SystemStateMapper systemStateMapper = mock(SystemStateMapper.class);
    private final SystemInitializationService systemInitializationService =
            new SystemInitializationService(systemStateMapper);

    @Test
    void shouldReturnUninitializedState() {
        when(systemStateMapper.findInitialized()).thenReturn(Optional.of(false));

        SystemInitializationStatusResponse response =
                systemInitializationService.getInitializationStatus();

        assertThat(response.initialized()).isFalse();
    }

    @Test
    void shouldReturnInitializedState() {
        when(systemStateMapper.findInitialized()).thenReturn(Optional.of(true));

        SystemInitializationStatusResponse response =
                systemInitializationService.getInitializationStatus();

        assertThat(response.initialized()).isTrue();
    }

    @Test
    void shouldFailWhenSystemStateIsMissing() {
        when(systemStateMapper.findInitialized()).thenReturn(Optional.empty());

        assertThatThrownBy(systemInitializationService::getInitializationStatus)
                .isInstanceOf(SystemStateNotFoundException.class)
                .hasMessage("系统初始化状态记录不存在");
    }

    @Test
    void shouldPropagateDatabaseFailure() {
        DataAccessResourceFailureException exception =
                new DataAccessResourceFailureException("database unavailable");
        when(systemStateMapper.findInitialized()).thenThrow(exception);

        assertThatThrownBy(systemInitializationService::getInitializationStatus)
                .isSameAs(exception);
    }
}
