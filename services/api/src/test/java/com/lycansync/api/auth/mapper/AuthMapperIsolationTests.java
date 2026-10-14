package com.lycansync.api.auth.mapper;

import com.lycansync.api.auth.config.LocalAuthFixtureConfiguration;
import org.apache.ibatis.builder.xml.XMLMapperBuilder;
import org.apache.ibatis.session.Configuration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 不连接数据库验证正式会话 Mapper 与测试密码夹具的隔离和注册。
 *
 * @author Wreckloud
 * @since 2026-10-14
 */
class AuthMapperIsolationTests {

    @Test
    void shouldLoadProductionMapperWithoutPasswordStatementsAndRegisterTestMapper() throws IOException {
        Configuration configuration = new Configuration();
        loadMapper(configuration, "mapper/auth/AuthMapper.xml");
        String namespace = AuthMapper.class.getName();
        assertThat(configuration.hasMapper(AuthMapper.class)).isTrue();
        assertThat(configuration.hasStatement(namespace + ".findSessionUser")).isTrue();
        assertThat(configuration.hasStatement(namespace + ".countLocalCredentials")).isTrue();
        assertThat(configuration.hasStatement(namespace + ".findLocalCredential")).isFalse();
        assertThat(configuration.hasStatement(namespace + ".insertLocalCredential")).isFalse();

        loadMapper(configuration, "mapper/auth/LocalCredentialMapper.xml");
        assertThat(configuration.hasMapper(LocalCredentialMapper.class)).isTrue();
        assertThat(configuration.hasStatement(LocalCredentialMapper.class.getName() + ".findByUsername")).isTrue();
        assertThat(configuration.hasStatement(LocalCredentialMapper.class.getName() + ".insert")).isTrue();
    }

    @Test
    void shouldProvidePasswordEncoderOnlyFromTestConfiguration() {
        new ApplicationContextRunner().withUserConfiguration(LocalAuthFixtureConfiguration.class).run(context -> {
            assertThat(context).hasSingleBean(PasswordEncoder.class);
            PasswordEncoder encoder = context.getBean(PasswordEncoder.class);
            assertThat(encoder.matches("fixture-password", encoder.encode("fixture-password"))).isTrue();
        });
    }

    private void loadMapper(Configuration configuration, String resource) throws IOException {
        try (var input = new ClassPathResource(resource).getInputStream()) {
            new XMLMapperBuilder(input, configuration, resource, configuration.getSqlFragments()).parse();
        }
    }
}
