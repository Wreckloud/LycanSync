package com.lycansync.api.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenAPI 文档配置。
 *
 * @author Wreckloud
 * @since 2026-09-01
 */
@Configuration(proxyBeanMethods = false)
public class OpenApiConfiguration {

    @Bean
    public OpenAPI lycanSyncOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("LycanSync API")
                        .description("LycanSync 后端接口")
                        .version("v1"));
    }
}
