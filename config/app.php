<?php
/**
 * Yii Application Config
 *
 * Edit this file at your own risk!
 *
 * The array returned by this file will get merged with
 * vendor/craftcms/cms/src/config/app/main.php and [web|console].php, when
 * Craft's bootstrap script is defining the configuration for the entire
 * application.
 *
 * You can define custom modules and system components, and even override the
 * built-in system components.
 */
return [
    'components' => [
        'redis' => [
            'class' => yii\redis\Connection::class,
            'hostname' => getenv('REDIS_SERVER'),
            'port' => 6379,
            'password' => getenv('REDIS_PASSWORD'),
        ],
        'cache' => [
            'class' => yii\redis\Cache::class,
            'defaultDuration' => 86400,
            'keyPrefix' => 'redis_key',
        ],
    ],
    'modules' => [
        'papertrain-module' => [
            'class' => \modules\papertrainmodule\PapertrainModule::class,
            'components' => [
                'papertrainService' => [
                    'class' => 'modules\papertrainmodule\services\PapertrainService',
                ],
                'pwaService' => [
                    'class' => 'modules\papertrainmodule\services\PWAService',
                ],
            ],
        ],
    ],
    'bootstrap' => ['papertrain-module'],
];